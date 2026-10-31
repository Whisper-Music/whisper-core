// Образец: что приложение даёт общей части Whisper Archive (rust/whisper/). Скопируй в src-tauri/src/whisper_host.rs
// своего приложения, подставь свои модули и подпись ключа и подключи в lib.rs рядом с whisper:
//     #[path = "../../src/core/rust/whisper/mod.rs"]
//     mod whisper;
//     mod whisper_host;
// Всё ниже обязательно: rust/whisper/ обращается к этим именам через crate::whisper_host.

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
