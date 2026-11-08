//! Discord Rich Presence: «Слушает …» в профиле Discord. ОБЩАЯ часть ядра Whisper (whisper-core): у всех
//! приложений одинаковая. Своё у приложения — ID приложения Discord, подпись и адрес кнопки (crate::whisper_host).
//! Подключение в src-tauri/src/lib.rs: #[path = "../../src/core/rust/discord.rs"] mod discord;
//!
//! Протокол IPC Discord простой, поэтому сторонние крейты не нужны:
//! * Windows — именованный канал `\\.\pipe\discord-ipc-N` (N = 0..9);
//! * Linux — unix-сокет `discord-ipc-N` в $XDG_RUNTIME_DIR (а также в путях Flatpak/Snap/Vesktop).
//! Кадр: код операции (u32 LE) + длина (u32 LE) + JSON. Сначала рукопожатие (op 0) с ID приложения,
//! в ответ READY с именем пользователя Discord; затем команды SET_ACTIVITY (op 1).
//!
//! Вся работа идёт в одном фоновом потоке: веб-страница только передаёт настройки и «что играет»,
//! а поток сам подключается к Discord (и переподключается, если Discord запустили позже
//! или перезапустили), не чаще раза в 15 с ищет его и не превышает лимит Discord
//! на обновление статуса (5 раз за 20 с). Пока RPC выключен, поток спит и ничего не делает.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

// Своё у каждого приложения (whisper_host.rs): приложение Discord (https://discord.com/developers/applications) —
// его название Discord показывает в строке «Слушает …»; кнопка в профиле — подпись (не длиннее 32 символов)
// и адрес страницы, откуда клиент можно скачать.
use crate::whisper_host::{APP_URL as REPO_URL, DISCORD_APP_ID as APP_ID, DISCORD_BUTTON as BUTTON_LABEL};

const RETRY: Duration = Duration::from_secs(15);
const MIN_GAP: Duration = Duration::from_secs(4);

#[derive(Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub enabled: bool,
    pub cover: bool,        // обложка трека
    pub button: bool,       // кнопка «Скачать Whisper» (ссылка на GitHub)
    pub show_paused: bool,  // на паузе статус остаётся (иначе пропадает)
    pub title_status: bool, // в списке участников — название трека вместо названия приложения
}
impl Default for Config {
    fn default() -> Self {
        Self { enabled: false, cover: true, button: true, show_paused: true, title_status: true }
    }
}

#[derive(Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_id: String,
    pub cover: String,
    pub duration_ms: u64,
    pub position_ms: u64,
    pub playing: bool,
    // "together" — в комнате «Слушать вместе», "sleep" — режим сна; пусто — просто слушает.
    // (старые версии страницы поля не шлют — выручает default у структуры)
    pub mode: String,
}

#[derive(Default)]
struct Want {
    cfg: Config,
    track: Option<Track>,
    at: u64,      // когда (unix, мс) пришла позиция трека — от неё считаются отметки времени
    gen: u64,     // растёт при любом изменении — поток видит, что пора отправить
    cfg_gen: u64, // растёт при смене настроек подключения — прерывает ожидание и переподключает
}

struct Shared {
    want: Mutex<Want>,
    cv: Condvar,
}

fn shared(app: &AppHandle) -> &'static Shared {
    static S: OnceLock<Shared> = OnceLock::new();
    let mut fresh = false;
    let s = S.get_or_init(|| {
        fresh = true;
        Shared { want: Mutex::new(Want::default()), cv: Condvar::new() }
    });
    if fresh {
        let app = app.clone();
        let _ = std::thread::Builder::new().name("discord-rpc".into()).spawn(move || worker(app, s));
    }
    s
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---------- состояние для интерфейса ----------

#[derive(Serialize, Clone, PartialEq)]
pub struct User {
    name: String,
    avatar: String,
}

/// state: off | wait (Discord не запущен) | badid (Discord не принял приложение) | on
#[derive(Serialize, Clone, PartialEq)]
pub struct Status {
    state: &'static str,
    user: Option<User>,
}

fn last_status() -> &'static Mutex<Status> {
    static L: OnceLock<Mutex<Status>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(Status { state: "off", user: None }))
}

fn set_status(app: &AppHandle, state: &'static str, user: Option<User>) {
    let st = Status { state, user };
    let mut l = last_status().lock().unwrap();
    if *l != st {
        *l = st.clone();
        drop(l);
        let _ = app.emit("discord-status", st);
    }
}

#[tauri::command]
pub fn discord_status() -> Status {
    last_status().lock().unwrap().clone()
}

#[tauri::command]
pub fn discord_config(app: AppHandle, cfg: Config) -> Status {
    let s = shared(&app);
    {
        let mut w = s.want.lock().unwrap();
        if w.cfg != cfg {
            if w.cfg.enabled != cfg.enabled {
                w.cfg_gen += 1;
            }
            w.cfg = cfg.clone();
            w.gen += 1;
            s.cv.notify_all();
        }
    }
    if !cfg.enabled {
        set_status(&app, "off", None);
    }
    discord_status()
}

/// «Повторить»: не ждать 15 с до следующей попытки найти Discord.
#[tauri::command]
pub fn discord_retry(app: AppHandle) {
    let s = shared(&app);
    let mut w = s.want.lock().unwrap();
    w.cfg_gen += 1;
    w.gen += 1;
    s.cv.notify_all();
}

#[tauri::command]
pub fn discord_update(app: AppHandle, track: Option<Track>) {
    let s = shared(&app);
    let mut w = s.want.lock().unwrap();
    w.track = track;
    w.at = now_ms();
    w.gen += 1;
    s.cv.notify_all();
}

// ---------- подключение ----------

#[cfg(windows)]
type Conn = std::fs::File;
#[cfg(unix)]
type Conn = std::os::unix::net::UnixStream;

#[cfg(windows)]
fn open() -> Option<Conn> {
    (0..10).find_map(|i| {
        std::fs::OpenOptions::new().read(true).write(true).open(format!(r"\\.\pipe\discord-ipc-{i}")).ok()
    })
}

/// Сокет Discord можно открыть, только если он принадлежит текущему пользователю и не доступен на запись
/// всем подряд (аудит F-10). Иначе другой пользователь системы мог бы заранее положить в /tmp свой
/// «discord-ipc-0» и подменить ответы Discord или получать статус «Слушает».
#[cfg(unix)]
fn socket_trusted(meta: &std::fs::Metadata, uid: u32) -> bool {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    meta.file_type().is_socket() && meta.uid() == uid && meta.mode() & 0o002 == 0
}

/// Каталог, где ищем сокет: свой (владелец — текущий пользователь, не доступен на запись остальным)
/// или общий системный /tmp (владелец root, «липкий» бит: чужие файлы в нём не подменить).
#[cfg(unix)]
fn base_trusted(meta: &std::fs::Metadata, uid: u32) -> bool {
    use std::os::unix::fs::MetadataExt;
    if !meta.is_dir() {
        return false;
    }
    let mode = meta.mode();
    (meta.uid() == uid && mode & 0o022 == 0) || (meta.uid() == 0 && mode & 0o1000 != 0)
}

#[cfg(unix)]
fn open() -> Option<Conn> {
    use std::path::PathBuf;
    let uid = unsafe { libc::getuid() };
    // XDG_RUNTIME_DIR — личный каталог пользователя (обычно /run/user/<uid>, права 0700) — первым делом
    let mut bases: Vec<PathBuf> = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .iter()
        .filter_map(|k| std::env::var_os(k).map(PathBuf::from))
        .filter(|p| p.is_absolute())
        .collect();
    bases.push(PathBuf::from("/tmp"));
    bases.dedup();
    // обычный Discord, Flatpak, Snap и Vesktop кладут сокет в разные места
    let subs = ["", "app/com.discordapp.Discord", "snap.discord", ".flatpak/dev.vencord.Vesktop/xdg-run", "app/dev.vencord.Vesktop"];
    for b in &bases {
        // каталоги из переменных окружения принимаем, только если ими не может управлять кто-то другой
        if !std::fs::metadata(b).is_ok_and(|m| base_trusted(&m, uid)) {
            continue;
        }
        for sub in subs {
            for i in 0..10 {
                let path = b.join(sub).join(format!("discord-ipc-{i}"));
                // symlink_metadata: ссылка на чужой сокет не считается своим сокетом
                let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
                if !socket_trusted(&meta, uid) {
                    continue;
                }
                if let Ok(c) = Conn::connect(&path) {
                    let _ = c.set_read_timeout(Some(Duration::from_secs(10)));
                    let _ = c.set_write_timeout(Some(Duration::from_secs(10)));
                    return Some(c);
                }
            }
        }
    }
    None
}

#[cfg(all(test, unix))]
mod sock_tests {
    use super::*;

    #[test]
    fn own_socket_only() {
        use std::os::unix::fs::PermissionsExt;
        let uid = unsafe { libc::getuid() };
        let d = std::env::temp_dir().join(format!("yd-sock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("discord-ipc-0");
        let _l = std::os::unix::net::UnixListener::bind(&p).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(socket_trusted(&std::fs::symlink_metadata(&p).unwrap(), uid));
        assert!(!socket_trusted(&std::fs::symlink_metadata(&p).unwrap(), uid.wrapping_add(1))); // чужой владелец
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(!socket_trusted(&std::fs::symlink_metadata(&p).unwrap(), uid)); // пишут все
        let f = d.join("plain");
        std::fs::write(&f, b"x").unwrap();
        assert!(!socket_trusted(&std::fs::symlink_metadata(&f).unwrap(), uid)); // не сокет
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(base_trusted(&std::fs::metadata(&d).unwrap(), uid));
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(!base_trusted(&std::fs::metadata(&d).unwrap(), uid));
        let _ = std::fs::remove_dir_all(&d);
    }
}

fn send(c: &mut Conn, op: u32, body: &Value) -> std::io::Result<()> {
    let data = serde_json::to_vec(body)?;
    let mut buf = Vec::with_capacity(8 + data.len());
    buf.extend_from_slice(&op.to_le_bytes());
    buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
    buf.extend_from_slice(&data);
    c.write_all(&buf)?;
    c.flush()
}

fn recv(c: &mut Conn) -> std::io::Result<(u32, Value)> {
    let mut head = [0u8; 8];
    c.read_exact(&mut head)?;
    let op = u32::from_le_bytes(head[0..4].try_into().unwrap());
    let len = u32::from_le_bytes(head[4..8].try_into().unwrap()) as usize;
    if len > 1 << 20 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "слишком большой ответ"));
    }
    let mut data = vec![0u8; len];
    c.read_exact(&mut data)?;
    Ok((op, serde_json::from_slice(&data).unwrap_or(Value::Null)))
}

enum ConnErr {
    NotRunning,
    BadId,
}

fn connect(id: &str) -> Result<(Conn, Option<User>), ConnErr> {
    let mut c = open().ok_or(ConnErr::NotRunning)?;
    send(&mut c, 0, &json!({ "v": 1, "client_id": id })).map_err(|_| ConnErr::NotRunning)?;
    match recv(&mut c) {
        Ok((1, v)) if v["evt"] == "READY" => {
            let u = &v["data"]["user"];
            let user = u["id"].as_str().map(|uid| {
                let name = u["global_name"].as_str().filter(|s| !s.is_empty())
                    .or(u["username"].as_str()).unwrap_or("").to_string();
                let avatar = match u["avatar"].as_str() {
                    Some(h) if h.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') && uid.bytes().all(|b| b.is_ascii_digit()) =>
                        format!("https://cdn.discordapp.com/avatars/{uid}/{h}.png?size=64"),
                    _ => String::new(),
                };
                User { name, avatar }
            });
            Ok((c, user))
        }
        // Discord закрывает соединение (op 2) с кодом 4000, если такого приложения нет
        Ok((2, _)) => Err(ConnErr::BadId),
        _ => Err(ConnErr::NotRunning),
    }
}

// ---------- статус ----------

/// Discord не принимает строки короче 2 и длиннее 128 символов.
fn fit(s: &str) -> String {
    let mut out: String = s.trim().chars().take(128).collect();
    while out.chars().count() < 2 {
        out.push('\u{2800}'); // невидимый символ: обычные пробелы Discord обрезает
    }
    out
}

fn activity(t: &Track, at: u64, cfg: &Config, with_display: bool) -> Value {
    if !t.playing && !cfg.show_paused {
        return Value::Null;
    }
    let artist = if t.artist.is_empty() { "Неизвестный исполнитель" } else { &t.artist };
    // Пауза отмечается в названии трека: при status_display_type = 2 именно его Discord показывает
    // в списке участников, и раньше там трек на паузе выглядел играющим.
    let mut a = json!({
        "type": 2, // «Слушает»
        "details": fit(&if t.playing { t.title.clone() } else { format!("⏸ {}", t.title) }),
        "state": fit(&if !t.playing {
            format!("На паузе · {artist}")
        } else {
            match t.mode.as_str() {
                "together" => format!("Слушает вместе · {artist}"),
                "sleep" => format!("Засыпает · {artist}"),
                _ => artist.to_string(),
            }
        }),
        "assets": {},
    });
    if with_display && cfg.title_status {
        a["status_display_type"] = json!(2);
    }
    if cfg.cover && t.cover.starts_with("https://") && t.cover.len() <= 256 {
        a["assets"]["large_image"] = json!(t.cover);
        if !t.album.is_empty() {
            a["assets"]["large_text"] = json!(fit(&t.album));
        }
    }
    if t.playing && t.duration_ms > 0 {
        let start = at.saturating_sub(t.position_ms);
        a["timestamps"] = json!({ "start": start, "end": start + t.duration_ms });
    }
    if cfg.button {
        a["buttons"] = json!([{ "label": BUTTON_LABEL, "url": REPO_URL }]);
    }
    a
}

fn set_activity(c: &mut Conn, nonce: &mut u64, act: Value) -> std::io::Result<bool> {
    *nonce += 1;
    send(c, 1, &json!({
        "cmd": "SET_ACTIVITY",
        "args": { "pid": std::process::id(), "activity": act },
        "nonce": nonce.to_string(),
    }))?;
    // ответ читаем, иначе буфер канала когда-нибудь переполнится; ERROR — Discord не принял статус
    loop {
        let (op, v) = recv(c)?;
        match op {
            1 if v["cmd"] == "SET_ACTIVITY" => return Ok(v["evt"] != "ERROR"),
            3 => { let _ = send(c, 4, &v); } // ping → pong
            2 => return Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "Discord закрыл соединение")),
            _ => continue,
        }
    }
}

fn worker(app: AppHandle, s: &'static Shared) {
    let mut conn: Option<Conn> = None;
    let mut sent_gen = u64::MAX;
    let mut last_send = Instant::now() - MIN_GAP;
    let mut last_try: Option<Instant> = None;
    let mut nonce = 0u64;
    let mut display_ok = true; // старые версии Discord не знают status_display_type
    let mut seen_cfg_gen = 0u64;

    loop {
        // ждём изменений; пока ждём подключения или паузы между отправками — просыпаемся по таймеру
        let (cfg, track, at, gen, cfg_gen) = {
            let mut w = s.want.lock().unwrap();
            loop {
                let pending = w.cfg.enabled && (conn.is_none() || w.gen != sent_gen);
                if pending || (!w.cfg.enabled && conn.is_some()) {
                    break;
                }
                w = s.cv.wait(w).unwrap();
            }
            (w.cfg.clone(), w.track.clone(), w.at, w.gen, w.cfg_gen)
        };
        if cfg_gen != seen_cfg_gen {
            seen_cfg_gen = cfg_gen;
            last_try = None; // включили или нажали «Повторить» — пробуем подключиться сразу
        }
        // выключили — закрываем соединение (Discord сам уберёт статус)
        if !cfg.enabled {
            if let Some(mut c) = conn.take() {
                let _ = set_activity(&mut c, &mut nonce, Value::Null);
            }
            sent_gen = u64::MAX;
            continue;
        }

        if conn.is_none() {
            if let Some(t) = last_try {
                let left = RETRY.saturating_sub(t.elapsed());
                if !left.is_zero() {
                    // ждём до следующей попытки; «Повторить» или выключение прерывают ожидание
                    let w = s.want.lock().unwrap();
                    drop(s.cv.wait_timeout_while(w, left, |w| w.cfg_gen == cfg_gen));
                    continue;
                }
            }
            last_try = Some(Instant::now());
            match connect(APP_ID) {
                Ok((c, user)) => {
                    conn = Some(c);
                    sent_gen = u64::MAX;
                    set_status(&app, "on", user);
                }
                Err(e) => {
                    set_status(&app, if matches!(e, ConnErr::BadId) { "badid" } else { "wait" }, None);
                    continue;
                }
            }
        }

        // не чаще лимита Discord; новые изменения за это время просто заменят старые
        let gap = MIN_GAP.saturating_sub(last_send.elapsed());
        if !gap.is_zero() {
            std::thread::sleep(gap);
            if s.want.lock().unwrap().gen != gen {
                continue;
            }
        }

        let c = conn.as_mut().unwrap();
        let act = track.as_ref().map(|t| activity(t, at, &cfg, display_ok)).unwrap_or(Value::Null);
        last_send = Instant::now();
        match set_activity(c, &mut nonce, act) {
            Ok(true) => sent_gen = gen,
            Ok(false) if display_ok => display_ok = false, // повторим без нового поля
            Ok(false) => sent_gen = gen,                  // Discord не принял — не долбим его тем же
            Err(_) => {
                conn = None;
                last_try = None; // сразу пробуем ещё раз: возможно, Discord просто перезапустился
                set_status(&app, "wait", None);
            }
        }
    }
}
