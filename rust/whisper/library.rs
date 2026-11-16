// Синхронизация библиотеки через архив (сервер: /api/library, описание — docs/LIBRARY-SYNC.md в репозитории архива).
// Свои треки пользователя (по ссылке, свои файлы, обрезки, замены) — запись с местом в «Лайках» и сам файл, чтобы на
// телефоне и другом компьютере была та же картина. ОБЩЕЕ для всех приложений Whisper: какая площадка — решает
// приложение (`service`: yandex, vk, archive), откуда брать файл трека и куда класть скачанный — тоже оно
// (у Whisper Music — studio.rs: studio_lib_upload / studio_lib_restore).
//
// Как и везде в whisper/: путь собирает Rust из проверенных частей, метод задаёт команда, ключ в JS не попадает.

use super::*;

pub const SERVICES: [&str; 3] = ["yandex", "vk", "archive"];
/// пачка изменений: не больше 100 записей и 100 удалений (как на сервере), тело — до 1 МБ
const MAX_BATCH: usize = 100;
const MAX_CHANGES_BODY: usize = 1024 * 1024;

pub fn service_ok(s: &str) -> bool {
    SERVICES.contains(&s)
}

/// key записи: `^[a-z0-9][a-z0-9_-]{0,63}$` (у Whisper Music — номер версии студии «studio-…»)
pub fn key_ok(k: &str) -> bool {
    let b = k.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-' || *c == b'_')
}

fn check(service: &str, key: Option<&str>) -> Result<(), String> {
    if !service_ok(service) {
        return Err("Неизвестная площадка библиотеки".into());
    }
    if key.is_some_and(|k| !key_ok(k)) {
        return Err("Некорректный номер трека библиотеки".into());
    }
    Ok(())
}

/// /api/library/{service}/{key}/file — для загрузки (upload.rs → Upload::to_library) и скачивания.
pub(super) fn file_path(service: &str, key: &str) -> Result<String, String> {
    check(service, Some(key))?;
    Ok(format!("/api/library/{service}/{key}/file"))
}

/// Тело /changes: объект только с массивами items и deleted, не больше 100 в каждом, deleted — проверенные key.
fn changes_body(v: &serde_json::Value) -> Result<Vec<u8>, String> {
    let o = v.as_object().ok_or("Изменения библиотеки — не объект")?;
    if o.keys().any(|k| k != "items" && k != "deleted") {
        return Err("В изменениях библиотеки лишние поля".into());
    }
    let items = o.get("items").map(|x| x.as_array().ok_or("items — не массив")).transpose()?;
    let deleted = o.get("deleted").map(|x| x.as_array().ok_or("deleted — не массив")).transpose()?;
    let (ni, nd) = (items.map_or(0, |a| a.len()), deleted.map_or(0, |a| a.len()));
    if ni > MAX_BATCH || nd > MAX_BATCH {
        return Err(format!("За раз — не больше {MAX_BATCH} записей и {MAX_BATCH} удалений"));
    }
    if ni + nd == 0 {
        return Err("Нет изменений".into());
    }
    if items.is_some_and(|a| a.iter().any(|x| !x.get("key").and_then(|k| k.as_str()).is_some_and(key_ok))) {
        return Err("Запись библиотеки без правильного key".into());
    }
    if deleted.is_some_and(|a| a.iter().any(|x| !x.as_str().is_some_and(key_ok))) {
        return Err("Удаление библиотеки без правильного key".into());
    }
    let b = serde_json::to_vec(v).map_err(|e| e.to_string())?;
    if b.len() > MAX_CHANGES_BODY {
        return Err("Слишком большая пачка изменений".into());
    }
    Ok(b)
}

/// Библиотека площадки (GET /api/library/{service}?since=N): since = 0 — вся, иначе — изменения после N.
#[tauri::command]
pub async fn wa_lib_list(service: String, since: u64) -> Result<WaResponse, String> {
    check(&service, None)?;
    let mut url = api_url(&format!("/api/library/{service}"))?;
    url.query_pairs_mut().append_pair("since", &since.to_string());
    let token = read_token()?;
    let resp = send_get(json_client(), url, &token).await?;
    let status = resp.status().as_u16();
    let bytes = read_limited(resp, MAX_JSON_BODY).await?;
    Ok(WaResponse { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

/// Пачка изменений (POST /api/library/{service}/changes): { items: [...], deleted: [key…] }.
#[tauri::command]
pub async fn wa_lib_changes(service: String, changes: serde_json::Value) -> Result<WaResponse, String> {
    check(&service, None)?;
    let body = changes_body(&changes)?;
    let url = api_url(&format!("/api/library/{service}/changes"))?;
    let token = read_token()?;
    let resp = json_client()
        .post(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Whisper Archive недоступен: {e}"))?;
    let status = resp.status().as_u16();
    let bytes = read_limited(resp, MAX_JSON_BODY).await?;
    Ok(WaResponse { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

/// Загрузить файл трека записи (PUT …/file). Файл даёт приложение; формат проверяется здесь (как у загрузки в альбом),
/// бюджет загрузок — общий с ними (upload.rs).
pub async fn upload_file(service: &str, key: &str, stem: &str, bytes: &[u8]) -> Result<WaResponse, String> {
    check(service, Some(key))?;
    if bytes.len() > upload::MAX_TRACK_UPLOAD {
        return Err("Файл больше 100 МБ — архив такие не берёт".into());
    }
    let track = upload::TrackFile::new(stem, bytes).ok_or_else(|| "Формат файла архив не берёт — подойдут mp3, flac, m4a, ogg, wav".to_string())?;
    upload::begin(None, None)?.to_library(service, key, track).await
}

/// Скачать файл трека записи (GET …/file) целиком — приложение кладёт его к себе с тем же key.
pub async fn download_file(service: &str, key: &str) -> Result<Vec<u8>, String> {
    let url = api_url(&file_path(service, key)?)?;
    let token = read_token()?;
    let _slot = host::heavy_slot().await?;
    let resp = send_get(media_client(), url, &token).await?;
    match resp.status().as_u16() {
        200..=299 => read_limited(resp, upload::MAX_TRACK_UPLOAD).await,
        404 => Err("файла этого трека в архиве пока нет".into()),
        s => Err(format!("архив ответил HTTP {s}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_services() {
        assert!(key_ok("studio-0123456789abcdef0123456789abcdef"));
        assert!(!key_ok("Studio-1"));
        assert!(!key_ok("-a"));
        assert!(!key_ok("a/b"));
        assert!(!key_ok(""));
        assert!(!key_ok(&"a".repeat(65)));
        assert!(service_ok("yandex") && service_ok("vk") && !service_ok("spotify"));
        assert_eq!(file_path("yandex", "studio-1").unwrap(), "/api/library/yandex/studio-1/file");
        assert!(file_path("yandex", "../x").is_err());
        assert!(api_url(&file_path("vk", "a_b-1").unwrap()).is_ok());
    }

    #[test]
    fn changes_shape() {
        use serde_json::json;
        assert!(changes_body(&json!({ "items": [{ "key": "studio-1", "title": "x" }], "deleted": ["studio-2"] })).is_ok());
        assert!(changes_body(&json!({ "deleted": ["studio-2"] })).is_ok());
        assert!(changes_body(&json!({})).is_err());
        assert!(changes_body(&json!([])).is_err());
        assert!(changes_body(&json!({ "items": [{ "title": "без key" }] })).is_err());
        assert!(changes_body(&json!({ "deleted": ["../x"] })).is_err());
        assert!(changes_body(&json!({ "deleted": ["a"], "method": "DELETE" })).is_err());
        let many: Vec<String> = (0..101).map(|i| format!("k{i}")).collect();
        assert!(changes_body(&json!({ "deleted": many })).is_err());
    }
}
