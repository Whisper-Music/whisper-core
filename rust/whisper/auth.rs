// Вход по почте (код из письма) — POST /api/auth/request-code и /api/auth/token: выданный ключ сразу уходит
// в хранилище, в JavaScript возвращается только никнейм.

use super::*;
use serde::Serialize;
use std::{sync::OnceLock, time::Duration};

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
// засыпать почту письмами или перебирать коды. Это не замена ограничениям на сервере архива —
// там они обязательны (запрос к API можно отправить и в обход приложения).
const CODE_MIN_GAP: Duration = Duration::from_secs(60); // письмо с кодом — не чаще раза в минуту
const CODE_WINDOW: Duration = Duration::from_secs(3600);
const CODE_PER_WINDOW: usize = 5; // и не больше пяти в час
const TRY_WINDOW: Duration = Duration::from_secs(600);
const TRY_PER_WINDOW: usize = 5; // попыток ввести код — пять за 10 минут

type Attempts = std::sync::Mutex<std::collections::VecDeque<std::time::Instant>>;

fn code_attempts() -> &'static Attempts {
    static A: OnceLock<Attempts> = OnceLock::new();
    A.get_or_init(Default::default)
}

fn try_attempts() -> &'static Attempts {
    static A: OnceLock<Attempts> = OnceLock::new();
    A.get_or_init(Default::default)
}

/// Записать попытку, если лимит позволяет. `gap` — минимальная пауза после предыдущей попытки.
fn rate_take(
    q: &mut std::collections::VecDeque<std::time::Instant>,
    now: std::time::Instant,
    window: Duration,
    max: usize,
    gap: Option<Duration>,
) -> Result<(), String> {
    while q.front().is_some_and(|t| now.duration_since(*t) > window) {
        q.pop_front();
    }
    if let (Some(g), Some(last)) = (gap, q.back()) {
        let since = now.duration_since(*last);
        if since < g {
            return Err(format!("Новый код можно запросить через {} с", (g - since).as_secs().max(1)));
        }
    }
    if q.len() >= max {
        let wait = q.front().map(|t| window.saturating_sub(now.duration_since(*t))).unwrap_or(window);
        return Err(format!("Слишком много попыток — попробуй через {} мин", wait.as_secs().div_ceil(60).max(1)));
    }
    q.push_back(now);
    Ok(())
}

/// Шаг 1: отправить код на почту. Никнейм нужен только для регистрации нового аккаунта.
#[tauri::command]
pub async fn wa_auth_request_code(email: String, nickname: Option<String>) -> Result<WaResponse, String> {
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
    rate_take(
        &mut code_attempts().lock().unwrap_or_else(|e| e.into_inner()),
        std::time::Instant::now(),
        CODE_WINDOW,
        CODE_PER_WINDOW,
        Some(CODE_MIN_GAP),
    )?;
    // новый код — новые попытки ввода
    try_attempts().lock().unwrap_or_else(|e| e.into_inner()).clear();
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
pub async fn wa_auth_issue(email: String, code: String) -> Result<WaLogin, String> {
    let email = email.trim().to_string();
    let code = code.trim().to_string();
    if !email_ok(&email) {
        return Err("Проверь адрес почты".into());
    }
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Код должен состоять из 6 цифр".into());
    }
    rate_take(
        &mut try_attempts().lock().unwrap_or_else(|e| e.into_inner()),
        std::time::Instant::now(),
        TRY_WINDOW,
        TRY_PER_WINDOW,
        None,
    )?;
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
    fn auth_rate_limits() {
        let t0 = std::time::Instant::now();
        let mut q = std::collections::VecDeque::new();
        let min = Duration::from_secs(60);
        assert!(rate_take(&mut q, t0, CODE_WINDOW, CODE_PER_WINDOW, Some(min)).is_ok());
        // второй код сразу — нельзя, через минуту — можно
        assert!(rate_take(&mut q, t0 + Duration::from_secs(5), CODE_WINDOW, CODE_PER_WINDOW, Some(min)).is_err());
        for i in 1..CODE_PER_WINDOW as u64 {
            assert!(rate_take(&mut q, t0 + Duration::from_secs(61 * i), CODE_WINDOW, CODE_PER_WINDOW, Some(min)).is_ok());
        }
        // лимит за час исчерпан
        assert!(rate_take(&mut q, t0 + Duration::from_secs(61 * 6), CODE_WINDOW, CODE_PER_WINDOW, Some(min)).is_err());
        // через час окно освобождается
        assert!(rate_take(&mut q, t0 + CODE_WINDOW + Duration::from_secs(1), CODE_WINDOW, CODE_PER_WINDOW, Some(min)).is_ok());

        let mut tries = std::collections::VecDeque::new();
        for _ in 0..TRY_PER_WINDOW {
            assert!(rate_take(&mut tries, t0, TRY_WINDOW, TRY_PER_WINDOW, None).is_ok());
        }
        assert!(rate_take(&mut tries, t0, TRY_WINDOW, TRY_PER_WINDOW, None).is_err());
    }
}
