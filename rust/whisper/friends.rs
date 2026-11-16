// Друзья (core/friends.js): список, заявки, поиск людей и их публичные профили — /api/friends, /api/profile.
// Как и везде в whisper/: интерфейс передаёт только данные (id, текст поиска), путь и метод Rust собирает сам.
// Сервер действует только от имени владельца ключа — чужой список друзей не прочитать ни одной командой.
//
// Картинки (аватар, обложка альбома) страница сама загрузить не может (CSP: img-src без адресов архива),
// поэтому wa_image отдаёт их байтами — страница показывает их через blob:.

use super::*;

const MAX_IMAGE: usize = 10 * 1024 * 1024; // обложка альбома в архиве — до 10 МБ, аватар — до 2 МБ

fn uuid(id: &str) -> Result<String, String> {
    if is_uuid(id) {
        Ok(id.to_ascii_lowercase())
    } else {
        Err("Некорректный id пользователя".into())
    }
}

/// Текст поиска: обрезанный, без управляющих символов, не длиннее 200 (ссылка на профиль длиннее никнейма).
fn search_text(q: &str) -> Result<String, String> {
    let q = q.trim();
    if q.is_empty() || q.chars().count() > 200 || q.chars().any(|c| c.is_control()) {
        return Err("Напиши никнейм или вставь ссылку на профиль".into());
    }
    Ok(q.to_string())
}

/// Номер версии картинки (?v= у адреса аватара) — только шестнадцатеричный, чтобы не попал в кэш старый аватар.
fn version_ok(v: &str) -> bool {
    (1..=16).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_hexdigit())
}

async fn call(method: reqwest::Method, url: Url) -> Result<WaResponse, String> {
    let token = read_token()?;
    let resp = json_client()
        .request(method, url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .header("Content-Length", "0")
        .send()
        .await
        .map_err(|e| format!("Whisper Archive недоступен: {e}"))?;
    let status = resp.status().as_u16();
    let bytes = read_limited(resp, MAX_SMALL_BODY).await?;
    Ok(WaResponse { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

/// Мои друзья и заявки: { friends: [{ id, nickname, avatar, since, online, app }], incoming, outgoing } (GET /api/friends).
#[tauri::command]
pub async fn wa_friends_list() -> Result<WaResponse, String> {
    call(reqwest::Method::GET, api_url("/api/friends")?).await
}

/// Найти людей по началу никнейма, id или ссылке на профиль: [{ id, nickname, avatar, relation }].
#[tauri::command]
pub async fn wa_friends_search(q: String) -> Result<WaResponse, String> {
    let q = search_text(&q)?;
    let mut url = api_url("/api/friends/search")?;
    url.query_pairs_mut().append_pair("q", &q);
    call(reqwest::Method::GET, url).await
}

/// Позвать в друзья (если он уже позвал тебя — сразу друзья): { relation }.
#[tauri::command]
pub async fn wa_friend_request(id: String) -> Result<WaResponse, String> {
    call(reqwest::Method::POST, api_url(&format!("/api/friends/{}", uuid(&id)?))?).await
}

/// Принять заявку: { relation: "friend" }.
#[tauri::command]
pub async fn wa_friend_accept(id: String) -> Result<WaResponse, String> {
    call(reqwest::Method::POST, api_url(&format!("/api/friends/{}/accept", uuid(&id)?))?).await
}

/// Отклонить заявку, отменить свою или убрать из друзей (DELETE /api/friends/{id}).
#[tauri::command]
pub async fn wa_friend_remove(id: String) -> Result<WaResponse, String> {
    call(reqwest::Method::DELETE, api_url(&format!("/api/friends/{}", uuid(&id)?))?).await
}

/// Публичный профиль: { id, nickname, avatar, albums: [{ id, title, trackCount, cover, visibility }] } (GET /api/profile/{id}).
/// Чужой профиль — только публичные альбомы; свой сервер отдаёт целиком.
#[tauri::command]
pub async fn wa_user_profile(id: String) -> Result<WaResponse, String> {
    let url = api_url(&format!("/api/profile/{}", uuid(&id)?))?;
    let token = read_token()?;
    let resp = send_get(json_client(), url, &token).await?;
    let status = resp.status().as_u16();
    let bytes = read_limited(resp, MAX_JSON_BODY).await?;
    Ok(WaResponse { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

/// Картинка архива байтами: kind "avatar" — аватар пользователя, "cover" — обложка альбома.
/// Ответ сервера должен быть картинкой (image/*) — иначе ошибка, страница покажет заглушку.
#[tauri::command]
pub async fn wa_image(kind: String, id: String, v: Option<String>) -> Result<tauri::ipc::Response, String> {
    let id = uuid(&id)?;
    let mut url = match kind.as_str() {
        "avatar" => api_url(&format!("/api/users/{id}/avatar"))?,
        "cover" => api_url(&format!("/api/albums/{id}/cover"))?,
        _ => return Err("Неизвестная картинка".into()),
    };
    if let Some(v) = v.filter(|v| version_ok(v)) {
        url.query_pairs_mut().append_pair("v", &v);
    }
    let token = read_token()?;
    let resp = json_client()
        .get(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "image/webp, image/png, image/jpeg")
        .send()
        .await
        .map_err(|e| format!("Whisper Archive недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let image = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.trim_start().to_ascii_lowercase().starts_with("image/"));
    if !image {
        return Err("Сервер прислал не картинку".into());
    }
    Ok(tauri::ipc::Response::new(read_limited(resp, MAX_IMAGE).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert_eq!(uuid("0F8FAD5B-D9CB-469F-A165-70867728950E").unwrap(), "0f8fad5b-d9cb-469f-a165-70867728950e");
        assert!(uuid("../api/me").is_err());
        assert!(uuid("0f8fad5b-d9cb-469f-a165-70867728950e/accept").is_err());
        assert!(uuid("").is_err());
    }

    #[test]
    fn search() {
        assert_eq!(search_text("  Анна ").unwrap(), "Анна");
        assert!(search_text("   ").is_err());
        assert!(search_text("a\nb").is_err());
        assert!(search_text(&"я".repeat(201)).is_err());
        assert!(search_text(&"я".repeat(200)).is_ok());
    }

    #[test]
    fn versions() {
        assert!(version_ok("8de1a2b3c4d5e6f"));
        assert!(!version_ok(""));
        assert!(!version_ok("12&x=1"));
        assert!(!version_ok("0123456789abcdef0"));
    }
}
