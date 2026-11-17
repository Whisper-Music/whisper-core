// Свой профиль Whisper Archive из приложения (core/profile.js): посмотреть себя, сменить никнейм и аватар.
// Сервер — /api/app/me (AppProfileController): только по API-ключу и только «лицо». Устройства, синхронизация и отзыв
// ключей туда не входят и остаются на сайте (браузерная сессия): утёкший ключ приложения не отключит другие устройства.
// Менять что-то может только ключ с доступом «запись» — ключ «только чтение» сервер остановит (403).
// Свои альбомы и лайкнутые — из публичного профиля (wa_user_profile со своим id: владельцу сервер отдаёт всё).

use super::upload::{send_multipart, Multipart};
use super::*;

/// Аватар — до 2 МБ (как на сайте, SafeImage.Avatar); сервер всё равно перекодирует картинку сам.
const MAX_AVATAR: usize = 2 * 1024 * 1024;

/// Никнейм как на сервере (ProfileService.CleanNickname): 3–32 символа, буквы, цифры, пробел, «.», «_», «-».
/// Здесь — та же проверка заранее, чтобы ошибка была сразу, а последнее слово всё равно за сервером.
fn nickname_ok(raw: &str) -> Result<String, String> {
    let s = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let n = s.chars().count();
    if !(3..=32).contains(&n) {
        return Err("Никнейм — от 3 до 32 символов".into());
    }
    if !s.chars().all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-')) {
        return Err("В никнейме можно использовать буквы, цифры, пробел, «.», «_» и «-»".into());
    }
    if !s.chars().any(char::is_alphanumeric) {
        return Err("В никнейме должна быть хотя бы одна буква или цифра".into());
    }
    Ok(s)
}

/// Что за картинка — по первым байтам (расширение и тип для multipart). Остальное — забота сервера.
fn image_kind(b: &[u8]) -> Option<(&'static str, &'static str)> {
    if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(("png", "image/png"))
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(("jpg", "image/jpeg"))
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some(("webp", "image/webp"))
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some(("gif", "image/gif"))
    } else {
        None
    }
}

async fn send(method: reqwest::Method, path: &str, json: Option<serde_json::Value>) -> Result<WaResponse, String> {
    let token = read_token()?;
    let mut rq = json_client()
        .request(method, api_url(path)?)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json");
    rq = match json {
        Some(v) => rq.header("Content-Type", "application/json").body(v.to_string()),
        None => rq.header("Content-Length", "0"),
    };
    let resp = rq.send().await.map_err(|e| format!("Whisper Archive недоступен: {e}"))?;
    let status = resp.status().as_u16();
    let bytes = read_limited(resp, MAX_SMALL_BODY).await?;
    Ok(WaResponse { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

/// Мой профиль: { id, nickname, email (скрытая), avatar, createdAt, nicknameChangeAvailableAt, storage { used, limit, library } }.
#[tauri::command]
pub async fn wa_my_profile() -> Result<WaResponse, String> {
    send(reqwest::Method::GET, "/api/app/me", None).await
}

/// Сменить никнейм (не чаще раза в час — так решает сервер). Ответ — профиль целиком.
#[tauri::command]
pub async fn wa_my_nickname(nickname: String) -> Result<WaResponse, String> {
    let n = nickname_ok(&nickname)?;
    send(reqwest::Method::PUT, "/api/app/me/nickname", Some(serde_json::json!({ "nickname": n }))).await
}

/// Поставить аватар: картинка одним двоичным куском (не JSON) — PNG, JPEG, WebP или GIF до 2 МБ. Ответ — { avatar }.
#[tauri::command]
pub async fn wa_my_avatar(request: tauri::ipc::Request<'_>) -> Result<WaResponse, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("Нет картинки".into());
    };
    if body.is_empty() {
        return Err("Нет картинки".into());
    }
    if body.len() > MAX_AVATAR {
        return Err("Аватар больше 2 МБ".into());
    }
    let (ext, ctype) = image_kind(body).ok_or("Подойдёт картинка PNG, JPEG, WebP или GIF")?;
    let token = read_token()?;
    let mut form = Multipart::new();
    form.file("file", &format!("avatar.{ext}"), ctype, body);
    send_multipart(reqwest::Method::PUT, "/api/app/me/avatar", &token, form).await
}

/// Убрать аватар (останется кружок с первой буквой ника).
#[tauri::command]
pub async fn wa_my_avatar_remove() -> Result<WaResponse, String> {
    send(reqwest::Method::DELETE, "/api/app/me/avatar", None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nicknames() {
        assert_eq!(nickname_ok("  Вадим   Whisper ").unwrap(), "Вадим Whisper");
        assert!(nickname_ok("ab").is_err());
        assert!(nickname_ok(&"я".repeat(33)).is_err());
        assert!(nickname_ok("a<b>c").is_err());
        assert!(nickname_ok("...").is_err());
        assert!(nickname_ok("user\u{202E}name").is_err());
        assert!(nickname_ok("good_nick-1.0").is_ok());
    }

    #[test]
    fn images() {
        assert_eq!(image_kind(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0]).unwrap().0, "png");
        assert_eq!(image_kind(&[0xFF, 0xD8, 0xFF, 0xE0]).unwrap().0, "jpg");
        assert_eq!(image_kind(b"RIFF\0\0\0\0WEBPVP8 ").unwrap().0, "webp");
        assert_eq!(image_kind(b"GIF89a....").unwrap().0, "gif");
        assert!(image_kind(b"<svg xmlns=").is_none());
        assert!(image_kind(b"MZ\x90\0").is_none());
    }
}
