//! Виджет для OBS: маленький HTTP-сервер только на 127.0.0.1, который отдаёт страницу мини-плеера
//! (добавляется в OBS как «Браузер» по адресу http://127.0.0.1:<порт>/) и то, что сейчас играет.
//! ОБЩАЯ часть ядра Whisper (whisper-core). Своё у приложения — откуда можно брать обложки (crate::whisper_host:
//! OBS_IMG_SRC для CSP страницы и cover_ok для адреса обложки). Подключение в src-tauri/src/lib.rs:
//! #[path = "../../src/core/rust/obs.rs"] mod obs;
//!
//! * Включается в настройках (obs.js ядра → obs_config). Выключен — порт закрыт, ничего не слушается.
//! * Страница виджета — rust/obs/widget.html ядра (вшита в приложение). Раз в секунду она спрашивает /state,
//!   а оформление стиля (секции «@@ css whisper-obs» / «@@ settings whisper-obs» из .wmt) берёт из /theme.css.
//! * Чужие сайты в браузере прочитать данные не могут: ответы без CORS, а запросы с подменённым Host
//!   (DNS rebinding) отклоняются — принимаются только 127.0.0.1:<порт> и localhost:<порт>.
//! * Аудит F-09: /state и /theme.css отвечают только с ключом ?k=<ключ> (случайные 128 бит, хранятся в папке
//!   настроек приложения, чтобы адрес в OBS не менялся от запуска к запуску). Без ключа — 403: другой
//!   локальный процесс или пользователь не узнает, что сейчас играет. Одновременно обслуживается не больше
//!   MAX_CONN соединений (лишние сразу закрываются), таймауты чтения и записи — 1 с.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const PORTS: [u16; 6] = [47821, 47822, 47823, 47824, 47825, 47826];
const WIDGET: &str = include_str!("obs/widget.html");
const WIDGET_JS: &str = include_str!("obs/widget.js");
/// Политика страницы виджета. Название трека, исполнитель и CSS темы приходят извне (сервис, файлы .wmt
/// из библиотеки тем): даже если в них окажется разметка или хитрый CSS, OBS не выполнит чужой скрипт
/// (только /widget.js), а CSS не сможет «позвонить» на чужой адрес (картинки — только обложки сервиса,
/// whisper_host::OBS_IMG_SRC).
fn widget_csp() -> &'static str {
    static CSP: OnceLock<String> = OnceLock::new();
    CSP.get_or_init(|| {
        format!(
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
    img-src 'self' data: {}; font-src 'self' data:; connect-src 'self'; \
    base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            crate::whisper_host::OBS_IMG_SRC
        )
    })
}
const MAX_STATE: usize = 64 * 1024;
const MAX_CSS: usize = 1024 * 1024;
const MAX_CONN: usize = 8;

static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static KEY: Mutex<String> = Mutex::new(String::new());

/// Ключ виджета: создаётся один раз и хранится в файле obs.key в папке настроек приложения.
fn load_key(app: &tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let ok = |k: &str| k.len() == 32 && k.bytes().all(|b| b.is_ascii_hexdigit());
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?.join("obs.key");
    if let Ok(k) = std::fs::read_to_string(&path) {
        let k = k.trim().to_string();
        if ok(&k) {
            return Ok(k);
        }
    }
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    let k: String = b.iter().map(|x| format!("{x:02x}")).collect();
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600).custom_flags(libc::O_NOFOLLOW); // подложенная ссылка не перезапишет чужой файл
    }
    o.open(&path).and_then(|mut f| f.write_all(k.as_bytes())).map_err(|e| e.to_string())?;
    Ok(k)
}

/// Сравнение без раннего выхода.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Значение параметра k из «/state?k=…&v=…».
fn key_param(target: &str) -> &str {
    target
        .split_once('?')
        .map(|(_, q)| q)
        .unwrap_or("")
        .split('&')
        .find_map(|kv| kv.strip_prefix("k="))
        .unwrap_or("")
}

#[derive(Default)]
struct Shared {
    state: Mutex<Value>,
    css: Mutex<String>,
    settings: Mutex<Value>,
    theme_ver: AtomicU64,
}

fn shared() -> &'static Shared {
    static S: OnceLock<Shared> = OnceLock::new();
    S.get_or_init(Shared::default)
}

static PORT: AtomicU16 = AtomicU16::new(0);
static STOP: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

fn respond(s: &mut TcpStream, status: &str, ctype: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: {}\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n",
        body.len(),
        widget_csp()
    );
    let _ = s.write_all(head.as_bytes());
    let _ = s.write_all(body);
    let _ = s.flush();
}

/// Освобождает место в пуле соединений, как бы ни закончилась обработка.
struct ConnGuard;
impl Drop for ConnGuard {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, SeqCst);
    }
}

fn handle(mut s: TcpStream, port: u16) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(1)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(1)));
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let started = std::time::Instant::now();
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        // общий срок на заголовки: соединение, которое шлёт по байту, не держит поток бесконечно
        if started.elapsed() > Duration::from_secs(3) {
            return;
        }
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
        if buf.len() > 16 * 1024 {
            return respond(&mut s, "431 Request Header Fields Too Large", "text/plain", b"");
        }
    }
    let req = String::from_utf8_lossy(&buf);
    let mut lines = req.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, path) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let host = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("host"))
        .map(|(_, v)| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return respond(&mut s, "421 Misdirected Request", "text/plain", b"");
    }
    if method != "GET" {
        return respond(&mut s, "405 Method Not Allowed", "text/plain", b"");
    }
    let target = path;
    let path = path.split('?').next().unwrap_or("");
    let sh = shared();
    let key = KEY.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let authorized = !key.is_empty() && same(key_param(target), &key);
    if matches!(path, "/state" | "/theme.css") && !authorized {
        return respond(&mut s, "403 Forbidden", "text/plain", b"");
    }
    match path {
        // сама страница виджета секретов не содержит; данные она берёт по ключу из своего адреса
        "/" | "/widget" => respond(&mut s, "200 OK", "text/html; charset=utf-8", WIDGET.as_bytes()),
        "/widget.js" => respond(&mut s, "200 OK", "text/javascript; charset=utf-8", WIDGET_JS.as_bytes()),
        "/state" => {
            let body = json!({
                "state": *sh.state.lock().unwrap(),
                "settings": *sh.settings.lock().unwrap(),
                "themeVer": sh.theme_ver.load(SeqCst),
            });
            respond(&mut s, "200 OK", "application/json; charset=utf-8", body.to_string().as_bytes())
        }
        "/theme.css" => {
            let css = sh.css.lock().unwrap().clone();
            respond(&mut s, "200 OK", "text/css; charset=utf-8", css.as_bytes())
        }
        _ => respond(&mut s, "404 Not Found", "text/plain", b""),
    }
}

fn start() -> Result<u16, String> {
    let mut stop = STOP.lock().unwrap();
    if stop.is_some() {
        return Ok(PORT.load(SeqCst));
    }
    let (listener, port) = PORTS
        .iter()
        .find_map(|&p| TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, p)).ok().map(|l| (l, p)))
        .ok_or_else(|| format!("порты {}–{} заняты другими программами", PORTS[0], PORTS[PORTS.len() - 1]))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let flag = Arc::new(AtomicBool::new(false));
    let f = flag.clone();
    std::thread::Builder::new()
        .name("obs-widget".into())
        .spawn(move || {
            while !f.load(SeqCst) {
                match listener.accept() {
                    Ok((s, _)) => {
                        // не больше MAX_CONN потоков: лишние соединения закрываются сразу
                        if ACTIVE.fetch_add(1, SeqCst) >= MAX_CONN {
                            ACTIVE.fetch_sub(1, SeqCst);
                            drop(s);
                            continue;
                        }
                        let guard = ConnGuard;
                        let _ = s.set_nonblocking(false);
                        let spawned = std::thread::Builder::new().name("obs-conn".into()).spawn(move || {
                            let _g = guard;
                            handle(s, port)
                        });
                        if spawned.is_err() {
                            std::thread::sleep(Duration::from_millis(50)); // guard уже освободил место
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(60)),
                    Err(_) => std::thread::sleep(Duration::from_millis(200)),
                }
            }
            // listener закрывается здесь — порт освобождается
        })
        .map_err(|e| e.to_string())?;
    PORT.store(port, SeqCst);
    *stop = Some(flag);
    Ok(port)
}

fn stop() {
    if let Some(f) = STOP.lock().unwrap().take() {
        f.store(true, SeqCst);
    }
    PORT.store(0, SeqCst);
}

#[derive(serde::Serialize)]
pub struct ObsInfo {
    port: u16,
    key: String,
}

/// Включить/выключить виджет. Возвращает порт (0 — выключен) и ключ для адреса виджета.
#[tauri::command]
pub fn obs_config(app: tauri::AppHandle, enabled: bool) -> Result<ObsInfo, String> {
    if enabled {
        let key = load_key(&app)?;
        *KEY.lock().unwrap_or_else(|e| e.into_inner()) = key.clone();
        Ok(ObsInfo { port: start()?, key })
    } else {
        stop();
        Ok(ObsInfo { port: 0, key: String::new() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn key_parsing() {
        assert_eq!(key_param("/state?k=abc&v=1"), "abc");
        assert_eq!(key_param("/theme.css?v=3&k=xyz"), "xyz");
        assert_eq!(key_param("/state"), "");
        assert_eq!(key_param("/state?kk=abc"), "");
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "ab"));
    }
}

/// Что играет (страница шлёт при смене трека, паузе, перемотке, смене цветов).
/// Обложка — только с адресов сервиса (whisper_host::cover_ok): виджет ничего не загружает из других мест.
#[tauri::command]
pub fn obs_state(state: Value) {
    let mut state = state;
    let foreign = state.get("cover").and_then(Value::as_str).is_some_and(|c| !c.is_empty() && !crate::whisper_host::cover_ok(c));
    if foreign {
        state["cover"] = Value::String(String::new());
    }
    if state.to_string().len() <= MAX_STATE {
        *shared().state.lock().unwrap() = state;
    }
}

/// Оформление текущего стиля для виджета: CSS и настройки из секций whisper-obs файла темы.
#[tauri::command]
pub fn obs_theme(css: String, settings: Value) {
    let sh = shared();
    let css = if css.len() > MAX_CSS { String::new() } else { css };
    let settings = if settings.to_string().len() > MAX_STATE { Value::Null } else { settings };
    let mut c = sh.css.lock().unwrap();
    let mut st = sh.settings.lock().unwrap();
    if *c != css || *st != settings {
        *c = css;
        *st = settings;
        sh.theme_ver.fetch_add(1, SeqCst);
    }
}
