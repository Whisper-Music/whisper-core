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

/// Гость: текущего трека ведущего у него нет — ни на своём сервисе, ни в своём архиве (POST /api/rooms/{code}/missing).
/// Ведущий с включённым «Делиться треками из архива» сохраняет его в свой архив — тогда у гостя он играет оттуда.
#[tauri::command]
pub async fn wa_room_missing(code: String, track_id: String) -> Result<WaResponse, String> {
    // номер трека любого сервиса — как у сервера комнат (RoomTrack.IsValid)
    let ok = (1..=40).contains(&track_id.len())
        && track_id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-'));
    if !ok {
        return Err("Некорректный номер трека".into());
    }
    let body = serde_json::json!({ "trackId": track_id });
    room_request(true, format!("/api/rooms/{}/missing", room_code(&code)?), Some(body), None).await
}

// ---------- друзья и приглашения ----------
// Друзья — те, с кем уже слушал в одной комнате (сервер запоминает при входе). Их можно позвать в свою комнату:
// у друга приложение ждёт приглашений (wa_room_invites с since — long-poll) и показывает уведомление.

/// Мои друзья: [{ id, nickname, lastMetAt, metCount, online }] (GET /api/rooms/friends).
#[tauri::command]
pub async fn wa_room_friends() -> Result<WaResponse, String> {
    room_request(false, "/api/rooms/friends".into(), None, None).await
}

/// Убрать из друзей (DELETE /api/rooms/friends/{id}).
#[tauri::command]
pub async fn wa_room_friend_forget(id: String) -> Result<WaResponse, String> {
    if !is_uuid(&id) {
        return Err("Некорректный id друга".into());
    }
    let url = api_url(&format!("/api/rooms/friends/{id}"))?;
    let token = read_token()?;
    let resp = json_client()
        .delete(url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("Whisper Archive недоступен: {e}"))?;
    let status = resp.status().as_u16();
    let bytes = read_limited(resp, MAX_SMALL_BODY).await?;
    Ok(WaResponse { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

/// Позвать друга в свою комнату (POST /api/rooms/{code}/invite {"userId"}).
#[tauri::command]
pub async fn wa_room_invite(code: String, user_id: String) -> Result<WaResponse, String> {
    if !is_uuid(&user_id) {
        return Err("Некорректный id друга".into());
    }
    let body = serde_json::json!({ "userId": user_id });
    room_request(true, format!("/api/rooms/{}/invite", room_code(&code)?), Some(body), None).await
}

/// Мои приглашения; с `since` сервер ждёт новых до 25 с (GET /api/rooms/invites?since=&app=).
/// `app` — какое это приложение («yandex», «vk»): друзья видят его рядом с ником.
#[tauri::command]
pub async fn wa_room_invites(since: Option<i64>, app: Option<String>) -> Result<WaResponse, String> {
    let mut url = api_url("/api/rooms/invites")?;
    {
        let mut q = url.query_pairs_mut();
        if let Some(v) = since {
            q.append_pair("since", &v.max(0).to_string());
        }
        if let Some(a) = app.filter(|a| (1..=20).contains(&a.len()) && a.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')) {
            q.append_pair("app", &a);
        }
    }
    let token = read_token()?;
    let resp = poll_client()
        .get(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Whisper Archive недоступен: {e}"))?;
    let status = resp.status().as_u16();
    let bytes = read_limited(resp, MAX_SMALL_BODY).await?;
    Ok(WaResponse { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

/// Отклонить приглашение (POST /api/rooms/invites/{id}/dismiss).
#[tauri::command]
pub async fn wa_room_invite_dismiss(id: String) -> Result<WaResponse, String> {
    if !room_id_ok(&id) {
        return Err("Некорректный id приглашения".into());
    }
    room_request(true, format!("/api/rooms/invites/{id}/dismiss"), None, None).await
}

// ---------- темы комнаты ----------
// Участник делится своим стилем (.wmt): файл уходит на сервер архива и живёт, пока жива комната;
// остальные видят его в снимке (themes) и скачивают, чтобы установить у себя.

/// encodeURIComponent → строка (название темы приходит в заголовке, а там только ASCII).
fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |c: u8| (c as char).to_digit(16);
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn header(req: &tauri::ipc::Request<'_>, name: &str) -> String {
    req.headers().get(name).and_then(|v| v.to_str().ok()).map(pct_decode).unwrap_or_default()
}

/// Поделиться темой с комнатой. Тело — байты файла темы (без перевода в JSON), заголовки:
/// x-room-code, x-theme-name, x-theme-author (в процентной кодировке).
#[tauri::command]
pub async fn wa_room_theme_share(request: tauri::ipc::Request<'_>) -> Result<WaResponse, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("Нет данных темы".into());
    };
    let code = header(&request, "x-room-code");
    let code = room_code(&code)?.to_string();
    let name = header(&request, "x-theme-name");
    let author = header(&request, "x-theme-author");
    let bytes = body.clone();
    let up = super::upload::begin(None, None)?;
    up.to_room_theme(&code, &name, &author, &bytes).await
}

/// Файл темы, которой поделились в комнате (GET /api/rooms/{code}/themes/{id}) — байтами, как файл с диска.
#[tauri::command]
pub async fn wa_room_theme_get(code: String, id: String) -> Result<tauri::ipc::Response, String> {
    if !is_uuid(&id) {
        return Err("Некорректный id темы".into());
    }
    let url = api_url(&format!("/api/rooms/{}/themes/{id}", room_code(&code)?))?;
    let token = read_token()?;
    let resp = send_get(media_client(), url, &token).await?;
    if !resp.status().is_success() {
        return Err(format!("Тема не скачалась: HTTP {}", resp.status().as_u16()));
    }
    let bytes = read_limited(resp, super::upload::MAX_THEME_UPLOAD + 1024).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Убрать тему из комнаты (DELETE /api/rooms/{code}/themes/{id}) — свою или любую, если ты ведущий.
#[tauri::command]
pub async fn wa_room_theme_remove(code: String, id: String) -> Result<WaResponse, String> {
    if !is_uuid(&id) {
        return Err("Некорректный id темы".into());
    }
    let url = api_url(&format!("/api/rooms/{}/themes/{id}", room_code(&code)?))?;
    let token = read_token()?;
    let resp = json_client()
        .delete(url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("Whisper Archive недоступен: {e}"))?;
    let status = resp.status().as_u16();
    let bytes = read_limited(resp, MAX_SMALL_BODY).await?;
    Ok(WaResponse { status, body: String::from_utf8_lossy(&bytes).into_owned() })
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
        assert_eq!(pct_decode("%D0%9C%D0%B5%D0%BB%20x"), "Мел x");
        assert_eq!(pct_decode("50%"), "50%");
        assert_eq!(pct_decode("%zz"), "%zz");
    }
}
