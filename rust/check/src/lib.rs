//! Сборка и тесты rust/whisper/ отдельно от приложения. Здесь вместо приложения — простой whisper_host:
//! ключ в памяти, свой семафор, Origin как у Tauri. Если это собирается и тесты проходят, папка подключится
//! в любом приложении, у которого есть свой whisper_host.rs (образец — rust/whisper_host.example.rs).
#![allow(dead_code, unused_macros)]

#[path = "../../whisper/mod.rs"]
mod whisper;
#[path = "../../discord.rs"]
mod discord;
#[path = "../../obs.rs"]
mod obs;

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
    pub(crate) const DISCORD_APP_ID: &str = "0";
    pub(crate) const DISCORD_BUTTON: &str = "Whisper";
    pub(crate) const APP_URL: &str = "https://github.com/Whisper-Music/whisper-core";
    pub(crate) const OBS_IMG_SRC: &str = "https://example.com";
    pub(crate) fn cover_ok(url: &str) -> bool {
        url.starts_with("https://example.com/")
    }
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
    let _ = whisper::library::upload_file("yandex", "studio-1", "x", b"ID3").await;
    let _ = whisper::library::download_file("yandex", "studio-1").await;
    let _ = whisper::library::wa_lib_list("yandex".into(), 0).await;
    let _ = whisper::library::wa_lib_changes("yandex".into(), serde_json::json!({})).await;
    let _ = whisper::library::key_ok("studio-1");
    let _ = whisper::friends::wa_friends_list().await;
    let _ = whisper::friends::wa_friends_search("x".into()).await;
    let _ = whisper::friends::wa_friend_request("x".into()).await;
    let _ = whisper::friends::wa_friend_accept("x".into()).await;
    let _ = whisper::friends::wa_friend_remove("x".into()).await;
    let _ = whisper::friends::wa_friend_block("x".into()).await;
    let _ = whisper::friends::wa_friend_unblock("x".into()).await;
    let _ = whisper::friends::wa_user_profile("x".into()).await;
    let _ = whisper::friends::wa_image("avatar".into(), "x".into(), None).await;
    obs::obs_state(serde_json::json!({ "cover": "https://evil.com/x" }));
    let _ = discord::discord_status();
}
