// «Слушать вместе» (src/together.js): комнаты на сервере архива, /api/rooms/…
// Разрешены только пути комнат; тело — JSON. Ожидание изменений (GET с ?since=) держится сервером до 25 с,
// поэтому у него свой клиент с запасом по времени.

use super::*;
use std::sync::OnceLock;

fn poll_client() -> &'static Client {
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| build_client(45))
}

fn room_code_ok(s: &str) -> bool {
    (4..=12).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

fn room_id_ok(id: &str) -> bool {
    (1..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn room_code(code: &str) -> Result<&str, String> {
    if room_code_ok(code) {
        Ok(code)
    } else {
        Err("Некорректный код комнаты".into())
    }
}

/// Запрос к комнате. Путь собирается здесь из проверенного кода комнаты — интерфейс передаёт только данные.
async fn room_request(post: bool, path: String, body: Option<serde_json::Value>, since: Option<i64>) -> Result<WaResponse, String> {
    let mut url = api_url(&path)?;
    let token = read_token()?;
    let resp = if !post {
        if let Some(v) = since {
            url.query_pairs_mut().append_pair("since", &v.max(0).to_string());
        }
        poll_client()
            .get(url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .send()
            .await
    } else {
        let text = match body {
            None => "{}".to_string(),
            Some(v) if v.is_object() => v.to_string(),
            Some(_) => return Err("Данные комнаты должны быть объектом".into()),
        };
        if text.len() > 32 * 1024 {
            return Err("Слишком большой запрос".into());
        }
        json_client()
            .post(url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .body(text)
            .send()
            .await
    }
    .map_err(|e| format!("Whisper Archive недоступен: {e}"))?;
    let status = resp.status().as_u16();
    let bytes = read_limited(resp, MAX_SMALL_BODY).await?;
    Ok(WaResponse { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

/// Создать комнату (POST /api/rooms).
#[tauri::command]
pub async fn wa_room_create() -> Result<WaResponse, String> {
    room_request(true, "/api/rooms".into(), None, None).await
}

/// Снимок комнаты; с `since` сервер ждёт изменений до 25 с (GET /api/rooms/{code}?since=).
#[tauri::command]
pub async fn wa_room_get(code: String, since: Option<i64>) -> Result<WaResponse, String> {
    room_request(false, format!("/api/rooms/{}", room_code(&code)?), None, since).await
}

#[tauri::command]
pub async fn wa_room_join(code: String) -> Result<WaResponse, String> {
    room_request(true, format!("/api/rooms/{}/join", room_code(&code)?), None, None).await
}

#[tauri::command]
pub async fn wa_room_leave(code: String) -> Result<WaResponse, String> {
    room_request(true, format!("/api/rooms/{}/leave", room_code(&code)?), None, None).await
}

/// Ведущий сообщает, что у него играет.
#[tauri::command]
pub async fn wa_room_state(code: String, state: serde_json::Value) -> Result<WaResponse, String> {
    room_request(true, format!("/api/rooms/{}/state", room_code(&code)?), Some(state), None).await
}

/// Гость предлагает трек.
#[tauri::command]
pub async fn wa_room_suggest(code: String, track: serde_json::Value) -> Result<WaResponse, String> {
    room_request(true, format!("/api/rooms/{}/suggest", room_code(&code)?), Some(track), None).await
}

/// Ведущий убирает предложение.
#[tauri::command]
pub async fn wa_room_dismiss(code: String, id: String) -> Result<WaResponse, String> {
    if !room_id_ok(&id) {
        return Err("Некорректный id предложения".into());
    }
    room_request(true, format!("/api/rooms/{}/suggestions/{id}/dismiss", room_code(&code)?), None, None).await
}

/// Ведущий передаёт управление другому участнику (POST /api/rooms/{code}/host, тело {"memberId": "…"}).
/// Комната и код остаются прежними; бывший ведущий становится гостем.
#[tauri::command]
pub async fn wa_room_transfer(code: String, member_id: String) -> Result<WaResponse, String> {
    // id участника может быть UUID — разрешаем ещё «-» и «_»
    let ok = (1..=64).contains(&member_id.len())
        && member_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !ok {
        return Err("Некорректный id участника".into());
    }
    let body = serde_json::json!({ "memberId": member_id });
    room_request(true, format!("/api/rooms/{}/host", room_code(&code)?), Some(body), None).await
}

/// Результат проверки пинга: `ms` — лучшее время ответа сервера комнат из трёх попыток (0 — замерить не удалось),
/// `status` — HTTP-статус замера (404 — комнаты нет), `report` — ответ сервера на отправку пинга (None — не отправляли).
#[derive(serde::Serialize)]
pub struct RoomPing {
    pub ms: u64,
    pub status: u16,
    pub report: Option<WaResponse>,
}

/// Пинг до сервера комнат: три коротких GET /api/rooms/{code} (без ожидания изменений), берётся лучший —
/// первый может включать установку соединения. Время меряется здесь, в Rust, без задержек IPC интерфейса.
/// `report` — отправить результат серверу (POST /api/rooms/{code}/ping {"pingMs"}), чтобы его увидели остальные.
#[tauri::command]
pub async fn wa_room_ping(code: String, report: bool) -> Result<RoomPing, String> {
    let path = format!("/api/rooms/{}", room_code(&code)?);
    let url = api_url(&path)?;
    let token = read_token()?;
    let mut best: Option<u64> = None;
    let mut status = 0u16;
    let mut last_err = String::new();
    for _ in 0..3 {
        let t = std::time::Instant::now();
        match json_client()
            .get(url.clone())
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) => {
                let ms = t.elapsed().as_millis() as u64;
                status = resp.status().as_u16();
                let _ = read_limited(resp, MAX_SMALL_BODY).await;
                if status == 404 || status == 403 {
                    break;
                }
                best = Some(best.map_or(ms, |b| b.min(ms)));
            }
            Err(e) => last_err = format!("Whisper Archive недоступен: {e}"),
        }
    }
    let Some(ms) = best else {
        if status != 0 {
            return Ok(RoomPing { ms: 0, status, report: None });
        }
        return Err(last_err);
    };
    let ms = ms.max(1);
    let report = if report {
        let body = serde_json::json!({ "pingMs": ms.min(60_000) });
        room_request(true, format!("{path}/ping"), Some(body), None).await.ok()
    } else {
        None
    };
    Ok(RoomPing { ms, status, report })
}

#[cfg(test)]
mod room_tests {
    use super::*;

    /// Ключ из хранилища, только чтение: cargo test --lib live_archive -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_archive() {
        tauri::async_runtime::block_on(async {
            let mine = wa_albums_mine().await.unwrap();
            println!("albums/mine: HTTP {} ({} bytes)", mine.status, mine.body.len());
            assert_eq!(mine.status, 200);
            let me = wa_me().await.unwrap();
            println!("auth/me: HTTP {}", me.status);
            assert!(wa_album("not-a-uuid".into()).await.is_err());
            assert!(wa_room_get("bad/code".into(), None).await.is_err());
        });
    }
    #[test]
    fn codes() {
        assert!(room_code("ABC234").is_ok());
        assert!(room_code("abc234").is_err());
        assert!(room_code("ABC/../x").is_err());
        assert!(room_code("").is_err());
        assert!(room_id_ok("a1b2c3"));
        assert!(!room_id_ok("a/b"));
        assert!(!room_id_ok(""));
    }
}
