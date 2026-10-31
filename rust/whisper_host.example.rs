// Образец: что приложение даёт общей части Whisper Archive (rust/whisper/). Скопируй в src-tauri/src/whisper_host.rs
// своего приложения, подставь свои модули и подпись ключа и подключи в lib.rs рядом с whisper:
//     #[path = "../../src/core/rust/whisper/mod.rs"]
//     mod whisper;
//     mod whisper_host;
// Всё ниже обязательно: rust/whisper/, rust/discord.rs и rust/obs.rs обращаются к этим именам через crate::whisper_host.
// Discord и OBS подключаются так же:
//     #[path = "../../src/core/rust/discord.rs"]
//     mod discord;
//     #[path = "../../src/core/rust/obs.rs"]
//     mod obs;

/// Ключ wa_… в системном хранилище (Диспетчер учётных данных Windows / связка ключей Linux / Keychain).
/// В JavaScript ключ не отдаётся никогда.
pub(crate) fn token_get() -> Result<Option<String>, String> {
    crate::secret::get_in(crate::secret::WA)
}
pub(crate) fn token_set(token: &str) -> Result<(), String> {
    crate::secret::set_in(crate::secret::WA, token)
}
pub(crate) fn token_clear() -> Result<(), String> {
    crate::secret::clear_in(crate::secret::WA)
}

/// Место для большого файла в памяти: общий для приложения семафор (треки сервиса, свой движок, архив),
/// чтобы десятки параллельных загрузок не съели память. Достаточно, например:
///     pub struct HeavySlot(tokio::sync::SemaphorePermit<'static>);
///     pub async fn heavy_slot() -> Result<HeavySlot, String> {
///         static S: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);
///         S.acquire().await.map(HeavySlot).map_err(|_| "Очередь загрузок закрыта".to_string())
///     }
pub(crate) use crate::net::heavy_slot;

/// Origin страниц приложения: протокол wa:// разрешает CORS только ему (аудит F-11). Например:
///     ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"].into_iter().find(|x| Some(*x) == origin)
pub(crate) use crate::net::app_origin;

/// Так приложение будет подписано в списке ключей на странице /developers (не длиннее 40 символов).
pub(crate) const DEVICE_NAME: &str = "Whisper VK";

// ---------- Discord и виджет OBS (rust/discord.rs, rust/obs.rs) ----------

/// Приложение Discord клиента (https://discord.com/developers/applications): его название Discord показывает
/// в строке «Слушает …». Своё приложение Discord — своё название («Whisper VK»).
pub(crate) const DISCORD_APP_ID: &str = "000000000000000000";
/// Кнопка в профиле Discord: подпись (не длиннее 32 символов) и страница, где клиент можно скачать.
pub(crate) const DISCORD_BUTTON: &str = "Скачать Whisper";
pub(crate) const APP_URL: &str = "https://github.com/Whisper-Music/…";

/// Откуда виджет OBS может брать картинки (CSP img-src его страницы): обложки своего сервиса.
pub(crate) const OBS_IMG_SRC: &str = "https://*.userapi.com";
/// Адрес обложки, который можно отдать виджету OBS: только обложки своего сервиса, только https.
pub(crate) fn cover_ok(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let Some((host, _)) = rest.split_once('/') else { return false };
    let host = host.to_ascii_lowercase();
    url.len() <= 2048 && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') && host.ends_with(".userapi.com")
}
