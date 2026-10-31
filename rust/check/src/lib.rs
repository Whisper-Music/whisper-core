//! Сборка и тесты rust/whisper/ отдельно от приложения. Здесь вместо приложения — простой whisper_host:
//! ключ в памяти, свой семафор, Origin как у Tauri. Если это собирается и тесты проходят, папка подключится
//! в любом приложении, у которого есть свой whisper_host.rs (образец — rust/whisper_host.example.rs).
#![allow(dead_code, unused_macros)]

#[path = "../../whisper/mod.rs"]
mod whisper;

mod whisper_host {
    use std::sync::Mutex;
    static TOKEN: Mutex<Option<String>> = Mutex::new(None);
    pub(crate) fn token_get() -> Result<Option<String>, String> {
        Ok(TOKEN.lock().unwrap().clone())
    }
    pub(crate) fn token_set(token: &str) -> Result<(), String> {
        *TOKEN.lock().unwrap() = Some(token.to_string());
        Ok(())
    }
    pub(crate) fn token_clear() -> Result<(), String> {
        *TOKEN.lock().unwrap() = None;
        Ok(())
    }
    pub struct HeavySlot(#[allow(dead_code)] tokio::sync::SemaphorePermit<'static>);
    pub(crate) async fn heavy_slot() -> Result<HeavySlot, String> {
        static S: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);
        S.acquire().await.map(HeavySlot).map_err(|_| "Очередь загрузок закрыта".to_string())
    }
    pub(crate) fn app_origin(origin: Option<&str>) -> Option<&'static str> {
        ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"].into_iter().find(|x| Some(*x) == origin)
    }
    pub(crate) const DEVICE_NAME: &str = "whisper-core check";
}

/// Всё, чем пользуется приложение: если здесь что-то перестало собираться, сломается и lib.rs приложения.
pub async fn api_surface(req: tauri::http::Request<Vec<u8>>) {
    let _ = whisper::stream::serve_stream(req).await;
    let _ = whisper::stream::parse_range(None);
    whisper::stream::clear_stream_cache();
    let _ = whisper::wa_token_exists();
    let _ = whisper::wa_track_bytes("").await;
    let _ = whisper::upload::begin(None, None);
    let _ = whisper::upload::album_title(Some("x"));
    let _ = whisper::upload::TrackFile::new("x", b"ID3");
    let _ = whisper::upload::MAX_TRACK_UPLOAD;
}
