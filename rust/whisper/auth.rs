// Вход по почте (код из письма) — POST /api/auth/request-code и /api/auth/token: выданный ключ сразу уходит
// в хранилище, в JavaScript возвращается только никнейм.

use super::*;
use serde::Serialize;
use std::sync::OnceLock;

// ---------------------------------------------------------------------------
// Вход по почте: код из письма -> ключ приложения (доступ на чтение и запись, 30 дней).
// ---------------------------------------------------------------------------


fn email_ok(e: &str) -> bool {
    (3..=254).contains(&e.len())
        && e.contains('@')
        && !e.chars().any(|c| c.is_whitespace() || c.is_control())
}

async fn post_json(path: &str, body: serde_json::Value) -> Result<WaResponse, String> {
    let resp = json_client()
        .post(api_url(path)?)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Whisper Archive недоступен: {e}"))?;
    let status = resp.status().as_u16();
    let bytes = read_limited(resp, MAX_SMALL_BODY).await?;
    Ok(WaResponse {
        status,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

// Частота входа по почте на стороне приложения: даже если в интерфейс попадёт чужой код, он не сможет
// засыпать почту письмами или перебирать коды. Это НЕ замена ограничениям на сервере архива — там они
// обязательны (запрос к API можно отправить и в обход приложения); что именно нужно серверу —
// docs/SERVER-AUTH.md приложения.
//
// Лимиты считаются и по каждому адресу, и по всем адресам вместе (смена адреса не обнуляет общий счётчик).
// Запрос нового кода НЕ сбрасывает попытки ввода — иначе перебор шёл бы по 5 попыток на каждое письмо.
// Счётчики хранятся в файле auth-limits.json в папке настроек, поэтому перезапуск приложения их не обнуляет.
// Адреса в файле не хранятся — только их хэш.
const CODE_MIN_GAP: u64 = 60; // письмо с кодом на один адрес — не чаще раза в минуту
const CODE_WINDOW: u64 = 3600;
const CODE_PER_ADDR: usize = 5; // не больше пяти писем в час на адрес
const CODE_PER_ALL: usize = 10; // и десяти в час на все адреса
const TRY_WINDOW: u64 = 600;
const TRY_PER_ADDR: usize = 5; // попыток ввести код — пять за 10 минут на адрес
const TRY_PER_ALL: usize = 15; // и пятнадцать за 10 минут на все адреса
const LIMITS_FILE: &str = "auth-limits.json";
const LIMITS_MAX_BYTES: u64 = 64 * 1024;
const LIMITS_MAX_ADDRS: usize = 64;

/// Метки времени (секунды Unix) запросов кодов и попыток ввода.
#[derive(Default, serde::Serialize, serde::Deserialize, Debug, PartialEq)]
struct Limits {
    #[serde(default)]
    codes_all: Vec<u64>,
    #[serde(default)]
    codes: std::collections::BTreeMap<String, Vec<u64>>,
    #[serde(default)]
    tries_all: Vec<u64>,
    #[serde(default)]
    tries: std::collections::BTreeMap<String, Vec<u64>>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Ключ адреса в счётчиках: хэш адреса в нижнем регистре (сам адрес на диск не пишется).
fn addr_key(email: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    email.trim().to_lowercase().hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Убрать устаревшие метки. Метки «из будущего» (часы перевели назад) считаются текущими,
/// иначе переводом часов можно было бы обойти лимит.
fn prune(q: &mut Vec<u64>, now: u64, window: u64) {
    for t in q.iter_mut() {
        *t = (*t).min(now);
    }
    q.retain(|t| now - *t < window);
    q.sort_unstable();
}

/// Можно ли ещё одну попытку (ничего не записывает). `gap` — минимальная пауза после предыдущей.
fn rate_check(q: &[u64], now: u64, window: u64, max: usize, gap: Option<u64>) -> Result<(), String> {
    if let (Some(g), Some(&last)) = (gap, q.last()) {
        let since = now.saturating_sub(last);
        if since < g {
            return Err(format!("Новый код можно запросить через {} с", (g - since).max(1)));
        }
    }
    if q.len() >= max {
        let oldest = q.first().copied().unwrap_or(now);
        let wait = window.saturating_sub(now.saturating_sub(oldest));
        return Err(format!("Слишком много попыток — попробуй через {} мин", wait.div_ceil(60).max(1)));
    }
    Ok(())
}

impl Limits {
    fn prune_all(&mut self, now: u64) {
        prune(&mut self.codes_all, now, CODE_WINDOW);
        prune(&mut self.tries_all, now, TRY_WINDOW);
        for q in self.codes.values_mut() {
            prune(q, now, CODE_WINDOW);
        }
        for q in self.tries.values_mut() {
            prune(q, now, TRY_WINDOW);
        }
        self.codes.retain(|_, q| !q.is_empty());
        self.tries.retain(|_, q| !q.is_empty());
        // файл не растёт бесконечно: держим самые свежие адреса
        for map in [&mut self.codes, &mut self.tries] {
            while map.len() > LIMITS_MAX_ADDRS {
                let stale = map.iter().min_by_key(|(_, q)| q.last().copied().unwrap_or(0)).map(|(k, _)| k.clone());
                match stale {
                    Some(k) => map.remove(&k),
                    None => break,
                };
            }
        }
    }

    /// Запрос кода: сначала проверка обоих лимитов, запись — только если проходят оба.
    fn take_code(&mut self, addr: &str, now: u64) -> Result<(), String> {
        self.prune_all(now);
        let mine = self.codes.get(addr).map(Vec::as_slice).unwrap_or(&[]);
        rate_check(mine, now, CODE_WINDOW, CODE_PER_ADDR, Some(CODE_MIN_GAP))?;
        rate_check(&self.codes_all, now, CODE_WINDOW, CODE_PER_ALL, None)?;
        self.codes.entry(addr.to_string()).or_default().push(now);
        self.codes_all.push(now);
        Ok(())
    }

    /// Попытка ввода кода. Новый запрос кода её счётчик не сбрасывает.
    fn take_try(&mut self, addr: &str, now: u64) -> Result<(), String> {
        self.prune_all(now);
        let mine = self.tries.get(addr).map(Vec::as_slice).unwrap_or(&[]);
        rate_check(mine, now, TRY_WINDOW, TRY_PER_ADDR, None)?;
        rate_check(&self.tries_all, now, TRY_WINDOW, TRY_PER_ALL, None)?;
        self.tries.entry(addr.to_string()).or_default().push(now);
        self.tries_all.push(now);
        Ok(())
    }

    /// Успешный вход: попытки этого адреса больше не нужны (общий счётчик остаётся).
    fn login_ok(&mut self, addr: &str) {
        self.tries.remove(addr);
    }
}

fn limits_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path().app_config_dir().ok().map(|d| d.join(LIMITS_FILE))
}

/// Счётчики из файла: только обычный файл (на Unix — не по ссылке), не больше LIMITS_MAX_BYTES.
/// Файла нет или он испорчен — пустые счётчики.
fn limits_load(path: &std::path::Path) -> Limits {
    use std::io::Read;
    let mut o = std::fs::OpenOptions::new();
    o.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let Ok(f) = o.open(path) else { return Limits::default() };
    if !f.metadata().is_ok_and(|m| m.is_file() && m.len() <= LIMITS_MAX_BYTES) {
        return Limits::default();
    }
    let mut b = Vec::new();
    if f.take(LIMITS_MAX_BYTES + 1).read_to_end(&mut b).is_err() || b.len() as u64 > LIMITS_MAX_BYTES {
        return Limits::default();
    }
    serde_json::from_slice(&b).unwrap_or_default()
}

/// Атомарная запись: временный файл (O_EXCL) и переименование поверх старого.
fn limits_save(path: &std::path::Path, l: &Limits) {
    use std::io::Write;
    let Some(dir) = path.parent() else { return };
    let _ = std::fs::create_dir_all(dir);
    let mut r = [0u8; 8];
    if getrandom::fill(&mut r).is_err() {
        return;
    }
    let tmp = dir.join(format!(".{LIMITS_FILE}.{}.tmp", r.iter().map(|b| format!("{b:02x}")).collect::<String>()));
    let Ok(bytes) = serde_json::to_vec(l) else { return };
    let res = (|| -> std::io::Result<()> {
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut f = o.open(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Счётчики в памяти (загружаются из файла при первом обращении) и путь к файлу.
fn limits() -> &'static std::sync::Mutex<Option<Limits>> {
    static L: OnceLock<std::sync::Mutex<Option<Limits>>> = OnceLock::new();
    L.get_or_init(Default::default)
}

/// Выполнить действие над счётчиками и сохранить их на диск.
fn with_limits<T>(app: &tauri::AppHandle, f: impl FnOnce(&mut Limits) -> T) -> T {
    let path = limits_path(app);
    let mut guard = limits().lock().unwrap_or_else(|e| e.into_inner());
    let l = guard.get_or_insert_with(|| path.as_deref().map(limits_load).unwrap_or_default());
    let out = f(l);
    if let Some(p) = &path {
        limits_save(p, l);
    }
    out
}

/// Шаг 1: отправить код на почту. Никнейм нужен только для регистрации нового аккаунта.
#[tauri::command]
pub async fn wa_auth_request_code(
    app: tauri::AppHandle,
    email: String,
    nickname: Option<String>,
) -> Result<WaResponse, String> {
    let email = email.trim().to_string();
    if !email_ok(&email) {
        return Err("Проверь адрес почты".into());
    }
    let nickname = nickname.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    if let Some(n) = &nickname {
        if n.chars().count() > 32 || n.chars().any(|c| c.is_control()) {
            return Err("Никнейм слишком длинный".into());
        }
    }
    let addr = addr_key(&email);
    with_limits(&app, |l| l.take_code(&addr, now_secs()))?;
    post_json(
        "/api/auth/request-code",
        serde_json::json!({ "email": email, "nickname": nickname }),
    )
    .await
}

#[derive(Serialize)]
pub struct WaLogin {
    ok: bool,
    status: u16,
    /// Текст ошибки сервера; при успехе пустой (тело ответа с ключом в JavaScript не отдаётся).
    body: String,
    nickname: Option<String>,
}

/// Шаг 2: обменять код на ключ. Ключ сразу кладётся в системное хранилище.
#[tauri::command]
pub async fn wa_auth_issue(app: tauri::AppHandle, email: String, code: String) -> Result<WaLogin, String> {
    let email = email.trim().to_string();
    let code = code.trim().to_string();
    if !email_ok(&email) {
        return Err("Проверь адрес почты".into());
    }
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Код должен состоять из 6 цифр".into());
    }
    let addr = addr_key(&email);
    with_limits(&app, |l| l.take_try(&addr, now_secs()))?;
    let r = post_json(
        "/api/auth/token",
        serde_json::json!({ "email": email, "code": code, "deviceName": host::DEVICE_NAME }),
    )
    .await?;
    if !(200..300).contains(&r.status) {
        return Ok(WaLogin { ok: false, status: r.status, body: r.body, nickname: None });
    }
    let v: serde_json::Value =
        serde_json::from_str(&r.body).map_err(|_| "Сервер вернул неожиданный ответ".to_string())?;
    let token = v
        .get("token")
        .and_then(|t| t.as_str())
        .ok_or_else(|| "В ответе сервера нет ключа".to_string())?;
    if !token_looks_valid(token) {
        return Err("Сервер выдал ключ в неожиданном виде".into());
    }
    stream::clear_stream_cache();
    host::token_set(token)?;
    with_limits(&app, |l| l.login_ok(&addr));
    let nickname = v
        .pointer("/user/nickname")
        .and_then(|x| x.as_str())
        .map(|s| s.chars().take(64).collect());
    Ok(WaLogin { ok: true, status: r.status, body: String::new(), nickname })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_limits() {
        let t0 = 1_000_000;
        let mut l = Limits::default();
        let a = addr_key("User@Mail.ru");
        assert_eq!(a, addr_key("  user@mail.ru ")); // регистр и пробелы не дают новый адрес
        assert!(l.take_code(&a, t0).is_ok());
        // второй код сразу — нельзя, через минуту — можно
        assert!(l.take_code(&a, t0 + 5).is_err());
        for i in 1..CODE_PER_ADDR as u64 {
            assert!(l.take_code(&a, t0 + 61 * i).is_ok());
        }
        // лимит адреса за час исчерпан
        assert!(l.take_code(&a, t0 + 61 * 6).is_err());
        // через час окно освобождается
        assert!(l.take_code(&a, t0 + CODE_WINDOW + 1).is_ok());
    }

    /// Смена адреса не обнуляет общий счётчик.
    #[test]
    fn code_limit_across_addresses() {
        let t0 = 1_000_000;
        let mut l = Limits::default();
        for i in 0..CODE_PER_ALL {
            assert!(l.take_code(&addr_key(&format!("u{i}@x.ru")), t0 + i as u64).is_ok());
        }
        assert!(l.take_code(&addr_key("fresh@x.ru"), t0 + 100).is_err());
        assert!(l.take_code(&addr_key("fresh@x.ru"), t0 + CODE_WINDOW + 20).is_ok());
    }

    /// Новый код не даёт новых попыток ввода; успешный вход снимает счётчик адреса.
    #[test]
    fn tries_not_reset_by_new_code() {
        let t0 = 1_000_000;
        let mut l = Limits::default();
        let a = addr_key("a@x.ru");
        for _ in 0..TRY_PER_ADDR {
            assert!(l.take_try(&a, t0).is_ok());
        }
        assert!(l.take_try(&a, t0).is_err());
        assert!(l.take_code(&a, t0 + 1).is_ok());
        assert!(l.take_try(&a, t0 + 2).is_err()); // попыток не прибавилось
        assert!(l.take_try(&a, t0 + TRY_WINDOW + 1).is_ok());
        l.login_ok(&a);
        assert!(!l.tries.contains_key(&a));

        // общий счётчик попыток по всем адресам
        let mut l = Limits::default();
        for i in 0..TRY_PER_ALL {
            assert!(l.take_try(&addr_key(&format!("u{}@x.ru", i / 2)), t0).is_ok());
        }
        assert!(l.take_try(&addr_key("other@x.ru"), t0).is_err());
    }

    /// Перевод часов назад лимит не обходит.
    #[test]
    fn clock_rollback() {
        let t0 = 1_000_000;
        let mut l = Limits::default();
        let a = addr_key("a@x.ru");
        for _ in 0..TRY_PER_ADDR {
            assert!(l.take_try(&a, t0).is_ok());
        }
        assert!(l.take_try(&a, t0 - 5000).is_err());
    }

    /// Счётчики переживают перезапуск: сохраняются и читаются из файла; испорченный файл — пустые счётчики.
    #[test]
    fn limits_persist() {
        let dir = std::env::temp_dir().join(format!("wa-limits-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(LIMITS_FILE);
        assert_eq!(limits_load(&p), Limits::default());
        let mut l = Limits::default();
        let a = addr_key("a@x.ru");
        l.take_code(&a, 1_000_000).unwrap();
        l.take_try(&a, 1_000_001).unwrap();
        limits_save(&p, &l);
        let back = limits_load(&p);
        assert_eq!(back, l);
        assert!(!std::fs::read_to_string(&p).unwrap().contains("a@x.ru")); // адреса на диске нет
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1); // временных файлов не осталось
        std::fs::write(&p, b"{broken").unwrap();
        assert_eq!(limits_load(&p), Limits::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn addr_map_bounded() {
        let mut l = Limits::default();
        for i in 0..(LIMITS_MAX_ADDRS as u64 + 20) {
            let _ = l.take_try(&addr_key(&format!("u{i}@x.ru")), 1_000_000 + i * 700);
        }
        assert!(l.tries.len() <= LIMITS_MAX_ADDRS);
    }
}
