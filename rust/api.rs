//! Локальная API приложений Whisper (Whisper API): программы Whisper на одном компьютере управляют друг другом —
//! например, микшер ставит одну тему сразу во все клиенты. Протокол — docs/API.md ядра.
//! ОБЩАЯ часть ядра (whisper-core). От приложения ничего не требует (без crate::whisper_host), поэтому подключается
//! и в программу без остального ядра (Whisper Mixer):
//!     #[path = "../../src/core/rust/api.rs"] mod api;
//! команды wapi_* — в generate_handler!, build.rs и capabilities; при выходе — api::shutdown().
//!
//! Как устроено:
//! * Каждое запущенное приложение слушает 127.0.0.1 на свободном порту (его выдаёт система) и пишет о себе файл
//!   <id>.json в общую папку реестра (registry_dir): id, название, порт, ключ и что умеет (caps). Выход — файл удаляется.
//! * Запрос — `METHOD /v1/<имя>` с заголовком `Authorization: Bearer <ключ из реестра>`. GET /v1/info отвечает сам Rust,
//!   остальное — обработчики страницы (core/api.js): Rust передаёт запрос событием «wapi» и ждёт ответ (wapi_reply)
//!   не дольше REPLY_WAIT.
//! * Защита: ключ — случайные 128 бит на каждый запуск, сравнение без раннего выхода; запросы браузера (есть Origin)
//!   и с подменённым Host (DNS rebinding) отклоняются; тело не больше MAX_BODY, соединений не больше MAX_CONN,
//!   таймауты на всё. Реестр лежит в папке пользователя (на Unix 0700, файлы 0600): ключ видят только программы того же
//!   пользователя, а им и так доступно всё его. Что можно сделать через API, решают обработчики страницы
//!   (тема проходит тот же фильтр безопасности cssSafe, что и тема из файла).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Версия протокола: меняется, только если старые программы перестанут понимать ответы.
pub const API: u32 = 1;
/// Тело запроса или ответа: как WMT.MAX_FILE — тема с фоном
const MAX_BODY: usize = 64 * 1024 * 1024;
const MAX_HEAD: usize = 16 * 1024;
const MAX_QUERY: usize = 2048;
const MAX_ENTRY: u64 = 16 * 1024;
const MAX_APPS: usize = 32;
const MAX_CONN: usize = 8;
const MAX_CAPS: usize = 64;
/// Сколько ждать ответа страницы: тема может спросить «Заменить стиль?» — тогда ответ придёт позже, а клиент узнает,
/// что приложение ждёт пользователя (504)
const REPLY_WAIT: Duration = Duration::from_secs(20);
const EVENT: &str = "wapi";

/// Запись реестра: файл <id>.json
#[derive(Clone, Serialize, Deserialize, Default, Debug, PartialEq)]
struct Entry {
    api: u32,
    id: String,
    name: String,
    #[serde(default)]
    version: String,
    port: u16,
    #[serde(default)]
    pid: u32,
    key: String,
    #[serde(default)]
    caps: Vec<String>,
}

// ---------------------------------------------------------------- проверки

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// id приложения = имя файла реестра: латиница в нижнем регистре, цифры, «.», «_», «-» (как id секции темы)
fn id_ok(s: &str) -> bool {
    (1..=40).contains(&s.len())
        && s.bytes().enumerate().all(|(i, b)| b.is_ascii_lowercase() || b.is_ascii_digit() || (i > 0 && matches!(b, b'.' | b'_' | b'-')))
}

/// Имя действия в адресе /v1/<имя>: «theme», «theme/file»
fn name_ok(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && !s.starts_with('/')
        && !s.ends_with('/')
        && !s.contains("//")
        && !s.contains("..")
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'/' | b'.' | b'_' | b'-'))
}

/// Возможность: «GET theme», «POST theme»
fn cap_ok(c: &str) -> bool {
    c.split_once(' ').is_some_and(|(m, n)| matches!(m, "GET" | "POST") && name_ok(n))
}

/// Строка запроса передаётся странице как есть, поэтому — только безопасные символы
fn query_ok(q: &str) -> bool {
    q.len() <= MAX_QUERY && q.bytes().all(|b| b.is_ascii_alphanumeric() || b"=&%._-+,".contains(&b))
}

fn key_ok(k: &str) -> bool {
    k.len() == 32 && k.bytes().all(|b| b.is_ascii_hexdigit())
}

fn clip(s: &str, n: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(n).collect::<String>().trim().to_string()
}

/// Сравнение без раннего выхода
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn new_key() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    Ok(hex(&b))
}

fn find(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}

// ---------------------------------------------------------------- реестр

/// Общая папка реестра. Windows — %LOCALAPPDATA%\Whisper\api; Linux — $XDG_RUNTIME_DIR/whisper-api
/// (личная папка сеанса, очищается при выходе), иначе ~/.cache/whisper/api.
#[cfg(windows)]
fn registry_dir() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty())?;
    Some(PathBuf::from(base).join("Whisper").join("api"))
}
#[cfg(not(windows))]
fn registry_dir() -> Option<PathBuf> {
    if let Some(r) = std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(r).join("whisper-api"));
    }
    let home = std::env::var_os("HOME").filter(|v| !v.is_empty())?;
    Some(PathBuf::from(home).join(".cache").join("whisper").join("api"))
}

/// Запись через новый временный файл и переименование: прерванная запись не оставит половину файла,
/// а подложенная на место файла ссылка не приведёт к записи в чужой файл (на Unix ещё O_NOFOLLOW и права 0600).
fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| std::io::Error::other("нет папки реестра"))?;
    let mut d = std::fs::DirBuilder::new();
    d.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        d.mode(0o700);
    }
    d.create(dir)?;
    let mut r = [0u8; 8];
    getrandom::fill(&mut r).map_err(|e| std::io::Error::other(e.to_string()))?;
    let tmp = dir.join(format!(".{}.tmp", hex(&r)));
    let res = (|| -> std::io::Result<()> {
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut f = o.open(&tmp)?;
        f.write_all(data)?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

fn write_entry(path: &Path, e: &Entry) -> std::io::Result<()> {
    let data = serde_json::to_vec_pretty(e).map_err(std::io::Error::other)?;
    write_private(path, &data)
}

/// Запись чужого приложения. Файл должен быть обычным (не ссылкой), небольшим, на Unix — своим,
/// а id внутри — совпадать с именем файла.
fn read_entry(path: &Path) -> Option<Entry> {
    let m = std::fs::symlink_metadata(path).ok()?;
    if !m.is_file() || m.len() > MAX_ENTRY {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid не имеет побочных эффектов и не может завершиться ошибкой
        if m.uid() != unsafe { libc::geteuid() } {
            return None;
        }
    }
    let e: Entry = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let stem = path.file_stem()?.to_str()?;
    (e.api >= 1 && id_ok(&e.id) && stem == e.id && key_ok(&e.key) && e.port != 0).then_some(e)
}

fn entries_in(dir: &Path) -> Vec<(PathBuf, Entry)> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<(PathBuf, Entry)> = rd
        .flatten()
        .map(|d| d.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .take(MAX_APPS * 2)
        .filter_map(|p| read_entry(&p).map(|e| (p, e)))
        .take(MAX_APPS)
        .collect();
    out.sort_by(|a, b| a.1.name.cmp(&b.1.name));
    out
}

// ---------------------------------------------------------------- сервер

struct Server {
    entry: Entry,
    label: String,
    stop: Arc<AtomicBool>,
    file: PathBuf,
}

static SERVER: Mutex<Option<Server>> = Mutex::new(None);
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static NEXT: AtomicU64 = AtomicU64::new(1);

struct Reply {
    status: u16,
    json: bool,
    body: Vec<u8>,
}
struct Pending {
    body: Option<Vec<u8>>,
    tx: mpsc::SyncSender<Reply>,
}

fn pending() -> &'static Mutex<HashMap<u64, Pending>> {
    static P: OnceLock<Mutex<HashMap<u64, Pending>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Payload Too Large",
        421 => "Misdirected Request",
        422 => "Unprocessable Entity",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Status",
    }
}

fn respond(s: &mut TcpStream, status: u16, json: bool, body: &[u8]) {
    let ctype = if json { "application/json; charset=utf-8" } else { "application/octet-stream" };
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        reason(status),
        body.len()
    );
    let _ = s.write_all(head.as_bytes());
    let _ = s.write_all(body);
    let _ = s.flush();
}

fn fail(s: &mut TcpStream, status: u16, msg: &str) {
    respond(s, status, true, json!({ "ok": false, "error": msg }).to_string().as_bytes());
}

/// Освобождает место в пуле соединений, как бы ни закончилась обработка
struct ConnGuard;
impl Drop for ConnGuard {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, SeqCst);
    }
}

/// Что нужно потоку соединения о сервере (копия — блокировка не держится, пока ждём страницу)
struct Now {
    entry: Entry,
    label: String,
}
fn now() -> Option<Now> {
    lock(&SERVER).as_ref().map(|s| Now { entry: s.entry.clone(), label: s.label.clone() })
}

fn info_json(e: &Entry) -> Value {
    json!({ "ok": true, "api": API, "id": e.id, "name": e.name, "version": e.version, "caps": e.caps })
}

fn handle(mut s: TcpStream) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(10)));
    let started = Instant::now();
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = vec![0u8; 64 * 1024];
    let end = loop {
        if let Some(p) = find(&buf, b"\r\n\r\n") {
            break p;
        }
        // общий срок на заголовки: соединение, которое шлёт по байту, не держит поток
        if started.elapsed() > Duration::from_secs(3) {
            return;
        }
        if buf.len() > MAX_HEAD {
            return fail(&mut s, 431, "заголовки слишком большие");
        }
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
    let mut rest = buf[end + 4..].to_vec();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let hdr: HashMap<String, String> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let Some(Now { entry, label }) = now() else { return fail(&mut s, 503, "API выключена") };
    let port = entry.port;
    let host = hdr.get("host").map(|h| h.to_ascii_lowercase()).unwrap_or_default();
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return fail(&mut s, 421, "неверный Host");
    }
    // браузер всегда шлёт Origin: страницы сайтов к API не допускаются, даже если узнают ключ
    if hdr.contains_key("origin") {
        return fail(&mut s, 403, "запросы из браузера не принимаются");
    }
    let token = hdr.get("authorization").and_then(|v| v.strip_prefix("Bearer ")).map(str::trim).unwrap_or("");
    if !same(token, &entry.key) {
        return fail(&mut s, 401, "нужен ключ из реестра приложений Whisper");
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let Some(name) = path.strip_prefix("/v1/") else { return fail(&mut s, 404, "нет такого адреса") };
    if !name_ok(name) {
        return fail(&mut s, 404, "нет такого адреса");
    }
    if !matches!(method, "GET" | "POST") {
        return fail(&mut s, 405, "только GET и POST");
    }
    if !query_ok(query) {
        return fail(&mut s, 400, "недопустимые символы в строке запроса");
    }
    if method == "GET" && name == "info" {
        return respond(&mut s, 200, true, info_json(&entry).to_string().as_bytes());
    }
    let cap = format!("{method} {name}");
    if !entry.caps.contains(&cap) {
        let other = entry.caps.iter().any(|c| c.split_once(' ').map(|x| x.1) == Some(name));
        return if other { fail(&mut s, 405, "это действие — другим методом") } else { fail(&mut s, 404, "приложение этого не умеет") };
    }
    let body = if method == "POST" {
        if hdr.contains_key("transfer-encoding") {
            return fail(&mut s, 400, "нужен Content-Length");
        }
        let Some(len) = hdr.get("content-length").and_then(|v| v.parse::<usize>().ok()) else {
            return fail(&mut s, 411, "нужен Content-Length");
        };
        if len > MAX_BODY {
            return fail(&mut s, 413, "тело больше 64 МБ");
        }
        rest.truncate(len);
        rest.reserve(len - rest.len());
        let deadline = Instant::now() + Duration::from_secs(30);
        while rest.len() < len {
            if Instant::now() > deadline {
                return;
            }
            match s.read(&mut chunk) {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    let take = n.min(len - rest.len());
                    rest.extend_from_slice(&chunk[..take]);
                }
            }
        }
        Some(rest)
    } else {
        None
    };
    let Some(app) = APP.get() else { return fail(&mut s, 503, "API выключена") };
    let id = NEXT.fetch_add(1, SeqCst);
    let size = body.as_ref().map_or(0, Vec::len);
    let (tx, rx) = mpsc::sync_channel(1);
    lock(pending()).insert(id, Pending { body, tx });
    let sent = app.emit_to(label.as_str(), EVENT, json!({ "id": id, "cap": cap, "query": query, "size": size }));
    let reply = if sent.is_ok() { rx.recv_timeout(REPLY_WAIT).ok() } else { None };
    lock(pending()).remove(&id);
    match reply {
        Some(r) => respond(&mut s, r.status, r.json, &r.body),
        None if sent.is_err() => fail(&mut s, 503, "окно приложения недоступно"),
        None => fail(&mut s, 504, "приложение не ответило — возможно, ждёт решения пользователя"),
    }
}

fn serve(listener: TcpListener, stop: Arc<AtomicBool>) {
    while !stop.load(SeqCst) {
        match listener.accept() {
            Ok((s, _)) => {
                if ACTIVE.fetch_add(1, SeqCst) >= MAX_CONN {
                    ACTIVE.fetch_sub(1, SeqCst);
                    drop(s);
                    continue;
                }
                let guard = ConnGuard;
                let _ = s.set_nonblocking(false);
                let spawned = std::thread::Builder::new().name("wapi-conn".into()).spawn(move || {
                    let _g = guard;
                    handle(s)
                });
                if spawned.is_err() {
                    std::thread::sleep(Duration::from_millis(50)); // guard уже освободил место
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => std::thread::sleep(Duration::from_millis(200)),
        }
    }
    // listener закрывается здесь — порт освобождается
}

fn stop_locked(sv: &mut Option<Server>) {
    if let Some(s) = sv.take() {
        s.stop.store(true, SeqCst);
        // файл — только свой: если его уже переписал новый экземпляр с другим ключом, не трогаем
        if read_entry(&s.file).is_some_and(|e| e.key == s.entry.key) {
            let _ = std::fs::remove_file(&s.file);
        }
    }
}

/// Закрыть API и убрать приложение из реестра — при выходе из программы (RunEvent::Exit)
pub fn shutdown() {
    stop_locked(&mut lock(&SERVER));
}

#[derive(Deserialize)]
pub struct StartInfo {
    id: String,
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    caps: Vec<String>,
}

fn clean_caps(caps: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in caps.into_iter().filter(|c| cap_ok(c)) {
        if !out.contains(&c) && out.len() < MAX_CAPS {
            out.push(c);
        }
    }
    out.sort();
    out
}

/// Включить API (или обновить, что приложение умеет). Повторный вызов с тем же id не меняет порт и ключ.
#[tauri::command]
pub fn wapi_start(app: tauri::AppHandle, webview: tauri::Webview, info: StartInfo) -> Result<Value, String> {
    if !id_ok(&info.id) {
        return Err("неверный id приложения".into());
    }
    let _ = APP.set(app);
    let caps = clean_caps(info.caps);
    let (name, version) = (clip(&info.name, 80), clip(&info.version, 40));
    let name = if name.is_empty() { info.id.clone() } else { name };
    let label = webview.label().to_string();
    let mut sv = lock(&SERVER);
    if let Some(s) = sv.as_mut().filter(|s| s.entry.id == info.id) {
        s.entry.name = name;
        s.entry.version = version;
        s.entry.caps = caps;
        s.label = label;
        write_entry(&s.file, &s.entry).map_err(|e| format!("реестр приложений не записан: {e}"))?;
        return Ok(json!({ "port": s.entry.port }));
    }
    stop_locked(&mut sv);
    let dir = registry_dir().ok_or("нет папки для реестра приложений")?;
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let entry = Entry { api: API, id: info.id, name, version, port, pid: std::process::id(), key: new_key()?, caps };
    let file = dir.join(format!("{}.json", entry.id));
    write_entry(&file, &entry).map_err(|e| format!("реестр приложений не записан: {e}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let f = stop.clone();
    std::thread::Builder::new().name("wapi".into()).spawn(move || serve(listener, f)).map_err(|e| e.to_string())?;
    *sv = Some(Server { entry, label, stop, file });
    Ok(json!({ "port": port }))
}

/// Выключить API (переключатель в настройках)
#[tauri::command]
pub fn wapi_stop() {
    shutdown();
}

/// Тело запроса для обработчика страницы (отдаётся один раз)
#[tauri::command]
pub fn wapi_body(id: u64) -> tauri::ipc::Response {
    let b = lock(pending()).get_mut(&id).and_then(|p| p.body.take()).unwrap_or_default();
    tauri::ipc::Response::new(b)
}

/// Ответ обработчика: тело одним куском (не JSON-массив чисел), id/код/тип — в заголовках x-wapi-*
#[tauri::command]
pub async fn wapi_reply(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let h = request.headers();
    let get = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let id: u64 = get("x-wapi-id").parse().map_err(|_| "нет id запроса".to_string())?;
    let status = get("x-wapi-status").parse::<u16>().ok().filter(|s| (200..600).contains(s)).unwrap_or(200);
    let json = get("x-wapi-type") != "bytes";
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        tauri::ipc::InvokeBody::Json(v) => v.to_string().into_bytes(),
    };
    if body.len() > MAX_BODY {
        return Err("ответ больше 64 МБ".into());
    }
    if let Some(p) = lock(pending()).get(&id) {
        let _ = p.tx.try_send(Reply { status, json, body });
    }
    Ok(())
}

// ---------------------------------------------------------------- клиент

enum Fail {
    /// никто не слушает порт — приложение закрылось без выхода (упало), запись устарела
    Gone,
    Err(String),
}

fn call(e: &Entry, method: &str, name: &str, query: &str, body: &[u8], wait: Duration) -> Result<(u16, Vec<u8>), Fail> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, e.port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(600)).map_err(|x| match x.kind() {
        ErrorKind::ConnectionRefused => Fail::Gone,
        _ => Fail::Err(x.to_string()),
    })?;
    let io = |x: std::io::Error| match x.kind() {
        ErrorKind::WouldBlock | ErrorKind::TimedOut => Fail::Err("приложение не ответило вовремя".into()),
        _ => Fail::Err(x.to_string()),
    };
    s.set_write_timeout(Some(Duration::from_secs(10))).map_err(io)?;
    s.set_read_timeout(Some(wait)).map_err(io)?;
    let q = if query.is_empty() { String::new() } else { format!("?{query}") };
    let head = format!(
        "{method} /v1/{name}{q} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        e.port,
        e.key,
        body.len()
    );
    s.write_all(head.as_bytes()).map_err(io)?;
    s.write_all(body).map_err(io)?;
    let mut out = Vec::new();
    (&mut s).take((MAX_BODY + MAX_HEAD) as u64).read_to_end(&mut out).map_err(io)?;
    let end = find(&out, b"\r\n\r\n").ok_or_else(|| Fail::Err("неполный ответ".into()))?;
    let status = std::str::from_utf8(&out[..end])
        .ok()
        .and_then(|h| h.split(' ').nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| Fail::Err("непонятный ответ".into()))?;
    Ok((status, out[end + 4..].to_vec()))
}

fn own() -> Option<Entry> {
    lock(&SERVER).as_ref().map(|s| s.entry.clone())
}

/// Запущенные приложения (кроме себя), которые отвечают: запись реестра + что они умеют сейчас.
/// Запись, чей порт никто не слушает, удаляется — приложение закрылось аварийно.
fn live() -> Vec<Entry> {
    let Some(dir) = registry_dir() else { return Vec::new() };
    let me = own();
    let list: Vec<(PathBuf, Entry)> = entries_in(&dir).into_iter().filter(|(_, e)| me.as_ref().map_or(true, |m| m.id != e.id)).collect();
    std::thread::scope(|sc| {
        let jobs: Vec<_> = list
            .iter()
            .map(|(p, e)| {
                sc.spawn(move || match call(e, "GET", "info", "", &[], Duration::from_millis(1500)) {
                    Ok((200, b)) => {
                        let v: Value = serde_json::from_slice(&b).ok()?;
                        let mut e = e.clone();
                        if let Some(c) = v.get("caps").and_then(Value::as_array) {
                            e.caps = clean_caps(c.iter().filter_map(|x| x.as_str().map(String::from)).collect());
                        }
                        Some(e)
                    }
                    Err(Fail::Gone) => {
                        let _ = std::fs::remove_file(p);
                        None
                    }
                    _ => None,
                })
            })
            .collect();
        jobs.into_iter().filter_map(|j| j.join().ok().flatten()).collect()
    })
}

#[derive(Serialize)]
pub struct AppInfo {
    id: String,
    name: String,
    version: String,
    caps: Vec<String>,
}

/// Какие ещё приложения Whisper запущены и что они умеют
#[tauri::command]
pub async fn wapi_apps() -> Result<Vec<AppInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        live().into_iter().map(|e| AppInfo { id: e.id, name: e.name, version: e.version, caps: e.caps }).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

fn send_to(targets: Vec<Entry>, method: &str, name: &str, query: &str, body: &[u8]) -> Vec<Value> {
    std::thread::scope(|sc| {
        let jobs: Vec<_> = targets
            .iter()
            .map(|e| {
                sc.spawn(move || {
                    let base = json!({ "id": e.id, "name": e.name });
                    let mut r = match call(e, method, name, query, body, REPLY_WAIT + Duration::from_secs(5)) {
                        Ok((status, b)) => {
                            let reply: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
                            let error = reply.get("error").and_then(Value::as_str).unwrap_or("").to_string();
                            json!({ "status": status, "ok": (200..300).contains(&status), "reply": reply, "error": error })
                        }
                        Err(Fail::Gone) => json!({ "status": 0, "ok": false, "error": "приложение закрылось" }),
                        Err(Fail::Err(x)) => json!({ "status": 0, "ok": false, "error": x }),
                    };
                    if let (Some(o), Some(b)) = (r.as_object_mut(), base.as_object()) {
                        o.extend(b.clone());
                    }
                    r
                })
            })
            .collect();
        jobs.into_iter().filter_map(|j| j.join().ok()).collect()
    })
}

/// Отправить запрос другим приложениям. Тело — одним куском; в заголовках: x-wapi-cap («POST theme»),
/// x-wapi-to (id через запятую; пусто — всем, кто это умеет), x-wapi-query (необязательно).
/// Ответ — по одному на приложение: { id, name, status, ok, reply, error }.
#[tauri::command]
pub async fn wapi_send(request: tauri::ipc::Request<'_>) -> Result<Vec<Value>, String> {
    let h = request.headers();
    let get = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").trim().to_string();
    let cap = get("x-wapi-cap");
    let to: Vec<String> = get("x-wapi-to").split(',').map(str::trim).filter(|x| id_ok(x)).map(String::from).collect();
    let query = get("x-wapi-query");
    if !cap_ok(&cap) {
        return Err("неверное действие".into());
    }
    if !query_ok(&query) {
        return Err("недопустимые символы в строке запроса".into());
    }
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        tauri::ipc::InvokeBody::Json(Value::Null) => Vec::new(),
        tauri::ipc::InvokeBody::Json(v) => v.to_string().into_bytes(),
    };
    if body.len() > MAX_BODY {
        return Err("больше 64 МБ".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (method, name) = cap.split_once(' ').unwrap_or(("GET", ""));
        let targets: Vec<Entry> = live().into_iter().filter(|e| e.caps.contains(&cap) && (to.is_empty() || to.contains(&e.id))).collect();
        send_to(targets, method, name, &query, &body)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Получить данные одного приложения (GET): например, его текущую тему файлом — app «whisper-music», cap «GET theme/file»
#[tauri::command]
pub async fn wapi_fetch(app: String, cap: String, query: Option<String>) -> Result<tauri::ipc::Response, String> {
    let query = query.unwrap_or_default();
    if !id_ok(&app) || !cap_ok(&cap) || !cap.starts_with("GET ") || !query_ok(&query) {
        return Err("неверный запрос".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<tauri::ipc::Response, String> {
        let e = live().into_iter().find(|e| e.id == app).ok_or("приложение не запущено")?;
        match call(&e, "GET", &cap[4..], &query, &[], REPLY_WAIT + Duration::from_secs(5)) {
            Ok((200..=299, b)) => Ok(tauri::ipc::Response::new(b)),
            Ok((status, b)) => {
                let v: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
                Err(v.get("error").and_then(Value::as_str).map(String::from).unwrap_or_else(|| format!("ответ {status}")))
            }
            Err(Fail::Gone) => Err("приложение закрылось".into()),
            Err(Fail::Err(x)) => Err(x),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(id_ok("whisper-music") && id_ok("whisper-vk") && id_ok("whisper-mixer"));
        assert!(!id_ok("") && !id_ok("-x") && !id_ok("Whisper") && !id_ok("a/b") && !id_ok("..") && !id_ok(&"a".repeat(41)));
        assert!(cap_ok("POST theme") && cap_ok("GET theme/file"));
        assert!(!cap_ok("PUT theme") && !cap_ok("GET /theme") && !cap_ok("GET a/../b") && !cap_ok("GET theme/") && !cap_ok("GET a//b") && !cap_ok("GETtheme"));
        assert!(query_ok("replace=1&to=a,b") && query_ok(""));
        assert!(!query_ok("a=<x>") && !query_ok("a\"b") && !query_ok(&"a".repeat(MAX_QUERY + 1)));
        assert!(same("abc", "abc") && !same("abc", "abd") && !same("abc", "ab"));
        assert_eq!(clean_caps(vec!["POST theme".into(), "bad".into(), "POST theme".into(), "GET theme".into()]), vec!["GET theme", "POST theme"]);
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wapi-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn registry_files() {
        let dir = tmpdir("reg");
        let e = Entry { api: 1, id: "whisper-x".into(), name: "X".into(), version: "1".into(), port: 5, pid: 1, key: "0".repeat(32), caps: vec![] };
        write_entry(&dir.join("whisper-x.json"), &e).unwrap();
        assert_eq!(read_entry(&dir.join("whisper-x.json")), Some(e.clone()));
        // имя файла не совпадает с id — запись чужая или подложенная
        write_entry(&dir.join("other.json"), &e).unwrap();
        assert_eq!(read_entry(&dir.join("other.json")), None);
        std::fs::write(dir.join("bad.json"), b"{").unwrap();
        let list = entries_in(&dir);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].1.id, "whisper-x");
        // временных файлов не остаётся
        assert!(std::fs::read_dir(&dir).unwrap().flatten().all(|d| !d.file_name().to_string_lossy().ends_with(".tmp")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Сервер без окна: info отвечает сам Rust, ключ и заголовки проверяются, неизвестное — 404
    #[test]
    fn server_checks() {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let entry = Entry { api: API, id: "whisper-test".into(), name: "Test".into(), version: "1".into(), port, pid: 1, key: new_key().unwrap(), caps: vec!["POST theme".into()] };
        let stop = Arc::new(AtomicBool::new(false));
        let dir = tmpdir("srv");
        *lock(&SERVER) = Some(Server { entry: entry.clone(), label: "main".into(), stop: stop.clone(), file: dir.join("whisper-test.json") });
        let f = stop.clone();
        let th = std::thread::spawn(move || serve(listener, f));
        let w = Duration::from_secs(3);

        let (st, b) = call(&entry, "GET", "info", "", &[], w).ok().unwrap();
        assert_eq!(st, 200);
        let v: Value = serde_json::from_slice(&b).unwrap();
        assert_eq!(v["id"], "whisper-test");
        assert_eq!(v["caps"][0], "POST theme");
        assert!(v.get("key").is_none(), "ключ в ответе не отдаётся");

        let wrong = Entry { key: "f".repeat(32), ..entry.clone() };
        assert_eq!(call(&wrong, "GET", "info", "", &[], w).ok().unwrap().0, 401);
        assert_eq!(call(&entry, "GET", "nothing", "", &[], w).ok().unwrap().0, 404);
        assert_eq!(call(&entry, "GET", "theme", "", &[], w).ok().unwrap().0, 405);
        // окна нет (APP не задан) — 503, но тело уже прочитано целиком
        assert_eq!(call(&entry, "POST", "theme", "", b"#WMT 1\n", w).ok().unwrap().0, 503);

        // запрос из браузера (Origin) и с чужим Host
        let raw = |req: String| {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.write_all(req.as_bytes()).unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
            out
        };
        let k = &entry.key;
        assert!(raw(format!("GET /v1/info HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: https://evil.com\r\nAuthorization: Bearer {k}\r\n\r\n")).contains(" 403 "));
        assert!(raw(format!("GET /v1/info HTTP/1.1\r\nHost: evil.com:{port}\r\nAuthorization: Bearer {k}\r\n\r\n")).contains(" 421 "));
        assert!(raw(format!("POST /v1/theme HTTP/1.1\r\nHost: localhost:{port}\r\nAuthorization: Bearer {k}\r\n\r\n")).contains(" 411 "));

        stop.store(true, SeqCst);
        th.join().unwrap();
        *lock(&SERVER) = None;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
