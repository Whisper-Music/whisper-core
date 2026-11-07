// whisper-core/rust/whisper/ — подключение Whisper Archive. ОБЩАЯ часть для всех приложений Whisper (Yandex, VK…):
// в ней нет ничего про конкретный музыкальный сервис, и в приложении она не правится (приходит подмодулем).
// Всё, что приложение даёт ей от себя (хранилище ключа, семафор тяжёлых загрузок, Origin своих окон, подпись ключа), —
// в его модуле `crate::whisper_host` (образец — rust/whisper_host.example.rs). Что делается с треками сервиса
// (например, «Сохранить в архив» для Яндекса) — тоже в приложении: whisper_yandex.rs, whisper_vk.rs…
//
// Подключение в src-tauri/src/lib.rs приложения (подмодуль лежит в src/core):
//     #[path = "../../src/core/rust/whisper/mod.rs"]
//     mod whisper;
//     mod whisper_host;
//
//  * mod.rs    — клиент, ключ (wa_token_*), свои альбомы, профиль, файл трека целиком;
//  * auth.rs   — вход по почте (код из письма → ключ);
//  * upload.rs — загрузка трека в архив: multipart, бюджет загрузок, проверка форматов (без скачивания из сервиса);
//  * stream.rs — потоковое воспроизведение wa://, заранее взятые начала треков;
//  * rooms.rs  — «Слушать вместе»: комнаты на сервере архива.
//
// Безопасность:
//  * API-ключ wa_… хранится в системном хранилище (whisper_host → хранилище приложения) и в JavaScript не отдаётся:
//    интерфейс передаёт его сюда один раз при сохранении;
//  * запросы идут только на https://origin.whisper-archive.ru, и интерфейс не задаёт ни метод, ни путь (аудит F-03):
//    у каждой операции своя команда, а путь Rust собирает сам из проверенных id;
//  * перенаправления разрешены только в пределах того же хоста — ключ не может уйти на чужой адрес;
//  * ключ отправляется в заголовке Authorization: Bearer wa_…, как описано в схеме API.

pub mod auth;
// то, что даёт приложение: ключ, heavy_slot, app_origin, DEVICE_NAME (rust/whisper_host.example.rs)
use crate::whisper_host as host;
pub mod rooms;
pub mod stream;
pub mod upload;

use serde::Serialize;
use std::{sync::OnceLock, time::Duration};
use tauri_plugin_http::reqwest::{self, redirect, Client, Url};

const BASE: &str = "https://origin.whisper-archive.ru";
const HOST: &str = "origin.whisper-archive.ru";

const MAX_JSON_BODY: usize = 16 * 1024 * 1024; // списки альбомов — до 16 МБ
const MAX_AUDIO_BODY: usize = 400 * 1024 * 1024; // файл трека (в архиве может быть FLAC/WAV) — до 400 МБ
const MAX_SMALL_BODY: usize = 1024 * 1024; // ответы на вход, загрузку и комнаты

fn read_token() -> Result<String, String> {
    host::token_get()?.ok_or_else(|| "Токен Whisper Archive не задан".to_string())
}

fn token_looks_valid(t: &str) -> bool {
    t.starts_with("wa_")
        && (8..=512).contains(&t.len())
        && t.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '+' | '/' | '=' | '~')
        })
}

fn build_client(total_secs: u64) -> Client {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(total_secs))
        .redirect(redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("слишком много перенаправлений");
            }
            let u = attempt.url();
            if u.scheme() == "https" && u.host_str() == Some(HOST) && u.port().is_none() {
                attempt.follow()
            } else {
                attempt.error("перенаправление на другой адрес запрещено")
            }
        }))
        .build()
        .expect("не удалось создать HTTP-клиент")
}

fn json_client() -> &'static Client {
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| build_client(30))
}

fn media_client() -> &'static Client {
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| build_client(600))
}

/// Только /api/…, без «..», двойных слешей, параметров и посторонних символов.
fn api_url(path: &str) -> Result<Url, String> {
    let ok = path.starts_with("/api/")
        && path.len() <= 200
        && !path.contains("..")
        && !path.contains("//")
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'/' || b == b'-' || b == b'_');
    if !ok {
        return Err("Недопустимый путь к API Whisper Archive".into());
    }
    Url::parse(&format!("{BASE}{path}")).map_err(|_| "Некорректный адрес".to_string())
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

async fn send_get(client: &Client, url: Url, token: &str) -> Result<reqwest::Response, String> {
    client
        .get(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json, audio/*;q=0.9, */*;q=0.8")
        .send()
        .await
        .map_err(|e| format!("Whisper Archive недоступен: {e}"))
}

/// Читает тело ответа кусками и обрывает загрузку, как только лимит превышен.
async fn read_limited(mut resp: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    if let Some(len) = resp.content_length() {
        if len > max as u64 {
            return Err("Ответ слишком большой".into());
        }
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if buf.len() + chunk.len() > max {
            return Err("Ответ слишком большой".into());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

#[derive(Serialize)]
pub struct WaResponse {
    pub status: u16,
    pub body: String,
}

/// Есть ли сохранённый ключ (сам ключ наружу не отдаётся).
#[tauri::command]
pub fn wa_token_exists() -> Result<bool, String> {
    host::token_get().map(|t| t.is_some())
}

/// Проверяет ключ запросом к серверу и только после этого сохраняет.
#[tauri::command]
pub async fn wa_token_set(token: String) -> Result<(), String> {
    let t = token.trim().to_string();
    if !token_looks_valid(&t) {
        return Err("токен должен начинаться с wa_ и не содержать пробелов".into());
    }
    let resp = send_get(json_client(), api_url("/api/albums/mine")?, &t).await?;
    match resp.status().as_u16() {
        200..=299 => {}
        401 | 403 => return Err("сервер не принял токен — проверь его на странице /developers".into()),
        s => return Err(format!("не удалось проверить токен: сервер ответил HTTP {s}")),
    }
    stream::clear_stream_cache();
    host::token_set(&t)
}

#[tauri::command]
pub fn wa_token_clear() -> Result<(), String> {
    stream::clear_stream_cache();
    host::token_clear()
}

async fn get_json(path: &str) -> Result<WaResponse, String> {
    let url = api_url(path)?;
    let token = read_token()?;
    let resp = send_get(json_client(), url, &token).await?;
    let status = resp.status().as_u16();
    let bytes = read_limited(resp, MAX_JSON_BODY).await?;
    Ok(WaResponse {
        status,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

/// Альбомы владельца ключа (GET /api/albums/mine) — из них строится список треков архива.
#[tauri::command]
pub async fn wa_albums_mine() -> Result<WaResponse, String> {
    get_json("/api/albums/mine").await
}

/// Один альбом с треками (GET /api/albums/{uuid}).
#[tauri::command]
pub async fn wa_album(id: String) -> Result<WaResponse, String> {
    if !is_uuid(&id) {
        return Err("Некорректный id альбома".into());
    }
    get_json(&format!("/api/albums/{id}")).await
}

/// Ссылка, чтобы поделиться своим альбомом (POST /api/albums/{uuid}/share): у приватного сервер сам
/// создаёт приглашение (/invite/…), у публичного — обычная страница альбома. Ответ — { url, visibility, expiresAt }.
#[tauri::command]
pub async fn wa_album_share(id: String) -> Result<WaResponse, String> {
    if !is_uuid(&id) {
        return Err("Некорректный id альбома".into());
    }
    let url = api_url(&format!("/api/albums/{id}/share"))?;
    let token = read_token()?;
    let resp = json_client()
        .post(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .header("Content-Length", "0")
        .send()
        .await
        .map_err(|e| format!("Whisper Archive недоступен: {e}"))?;
    let status = resp.status().as_u16();
    let bytes = read_limited(resp, MAX_JSON_BODY).await?;
    Ok(WaResponse { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

/// Открыть чужой приватный альбом по ссылке-приглашению (whisper://wa/{альбом}?k={ключ} — так делятся своей версией трека).
/// Сайт пускает по приглашению через cookie `WArchive.Invite.{альбом}`; у приложения cookie нет, поэтому ключ
/// приглашения уходит этим же заголовком, но только в эти два запроса и не сохраняется. Лайк альбома (PUT …/like) —
/// так сервер запоминает доступ для ключа приложения (AlbumAccessService: лайк при действующей ссылке), иначе
/// поток трека (wa://, без cookie) не откроется. Свой альбом лайкнуть нельзя — он и так доступен.
/// Ответ — альбом (как wa_album).
#[tauri::command]
pub async fn wa_invite_open(id: String, key: String) -> Result<WaResponse, String> {
    if !is_uuid(&id) {
        return Err("Некорректный id альбома".into());
    }
    if !(20..=200).contains(&key.len()) || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("Некорректная ссылка-приглашение".into());
    }
    let id = id.to_ascii_lowercase();
    let token = read_token()?;
    let cookie = format!("WArchive.Invite.{id}={key}");
    let like = json_client()
        .put(api_url(&format!("/api/albums/{id}/like"))?)
        .header("Authorization", format!("Bearer {token}"))
        .header("Cookie", &cookie)
        .header("Accept", "application/json")
        .header("Content-Length", "0")
        .send()
        .await
        .map_err(|e| format!("Whisper Archive недоступен: {e}"))?;
    let like_status = like.status().as_u16();
    // 400 — свой альбом (лайкнуть нельзя, но он и так открыт); остальное — ниже скажет сам альбом
    let _ = read_limited(like, MAX_JSON_BODY).await;
    let resp = json_client()
        .get(api_url(&format!("/api/albums/{id}"))?)
        .header("Authorization", format!("Bearer {token}"))
        .header("Cookie", &cookie)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Whisper Archive недоступен: {e}"))?;
    let status = resp.status().as_u16();
    let bytes = read_limited(resp, MAX_JSON_BODY).await?;
    if (200..300).contains(&status) && !(200..300).contains(&like_status) && like_status != 400 {
        // альбом открылся, а лайк не встал — по ключу приложения поток не пустят; лучше сказать сразу
        return Ok(WaResponse { status: 409, body: format!("{{\"message\":\"архив не сохранил доступ (HTTP {like_status})\"}}") });
    }
    Ok(WaResponse { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

/// Профиль владельца ключа (GET /api/auth/me) — только чтобы показать никнейм.
#[tauri::command]
pub async fn wa_me() -> Result<WaResponse, String> {
    get_json("/api/auth/me").await
}

/// Файл трека из архива (/api/tracks/{id}/stream) «сырыми» байтами — в JS это ArrayBuffer.
#[tauri::command]
pub async fn wa_stream(id: String) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(wa_track_bytes(&id).await?))
}

/// Файл трека из архива целиком (и для wa_stream, и для своего звукового движка — engine.rs).
pub async fn wa_track_bytes(id: &str) -> Result<Vec<u8>, String> {
    if !is_uuid(id) {
        return Err("Некорректный id трека".into());
    }
    let token = read_token()?;
    let url = api_url(&format!("/api/tracks/{id}/stream"))?;
    let _slot = host::heavy_slot().await?; // до 400 МБ в памяти — не больше трёх таких загрузок сразу
    let resp = send_get(media_client(), url, &token).await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    read_limited(resp, MAX_AUDIO_BODY).await
}
