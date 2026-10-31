// Загрузка трека в архив: multipart-запрос в новый альбом (POST /api/albums) или в существующий
// (POST /api/albums/{id}/tracks). Откуда взялся файл трека, здесь не важно: его скачивает приложение
// из своего сервиса (whisper_yandex.rs для Яндекса) и передаёт сюда уже байтами.
//
// Порядок для приложения: begin() → скачать трек → TrackFile::new() → to_album() или album_title() + new_album().

use super::*;
use std::{sync::OnceLock, time::Duration};


pub const MAX_TRACK_UPLOAD: usize = 100 * 1024 * 1024; // лимит сервера на один трек
pub const MAX_COVER_UPLOAD: usize = 10 * 1024 * 1024; // лимит сервера на обложку
pub const MAX_ALBUM_TITLE: usize = 75;

/// Формат обложки по первым байтам: сервер требует, чтобы расширение совпадало с содержимым.
pub fn image_kind(b: &[u8]) -> Option<(&'static str, &'static str)> {
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(("cover.jpg", "image/jpeg"))
    } else if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("cover.png", "image/png"))
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some(("cover.webp", "image/webp"))
    } else {
        None
    }
}

/// Расширение аудиофайла по первым байтам (только форматы, которые принимает сервер).
pub fn audio_kind(b: &[u8]) -> Option<(&'static str, &'static str)> {
    if b.starts_with(b"ID3") || (b.len() > 1 && b[0] == 0xFF && (b[1] & 0xE0) == 0xE0) {
        Some(("mp3", "audio/mpeg"))
    } else if b.starts_with(b"fLaC") {
        Some(("flac", "audio/flac"))
    } else if b.starts_with(b"OggS") {
        Some(("ogg", "audio/ogg"))
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WAVE" {
        Some(("wav", "audio/wav"))
    } else if b.len() > 8 && &b[4..8] == b"ftyp" {
        Some(("m4a", "audio/mp4"))
    } else {
        None
    }
}

/// Имя файла = название трека в архиве («Исполнитель - Название»): убираем то, что сломает путь или заголовок.
pub fn clean_stem(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| if c.is_control() || r#"\/:*?"<>|"#.contains(c) { ' ' } else { c })
        .collect();
    let mut s = mapped.split_whitespace().collect::<Vec<_>>().join(" ");
    s = s.trim_matches(|c: char| c == '.' || c == ' ').to_string();
    let s: String = s.chars().take(180).collect();
    if s.is_empty() { "Трек".into() } else { s }
}

pub fn clean_title(t: &str) -> String {
    let s = t
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    s.chars().take(MAX_ALBUM_TITLE).collect::<String>().trim().to_string()
}

fn random_boundary() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut s = String::from("----WhisperEdition");
    for i in 0..2u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i);
        s.push_str(&format!("{:016x}", h.finish()));
    }
    s
}

/// RFC 5987: имя файла в кодировке UTF-8 для filename*.
fn pct_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Простой multipart/form-data без внешних зависимостей.
struct Multipart {
    boundary: String,
    body: Vec<u8>,
}

impl Multipart {
    fn new() -> Self {
        Self { boundary: random_boundary(), body: Vec::new() }
    }

    fn text(&mut self, name: &str, value: &str) {
        self.body.extend_from_slice(
            format!(
                "--{}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n",
                self.boundary
            )
            .as_bytes(),
        );
    }

    fn file(&mut self, name: &str, filename: &str, content_type: &str, data: &[u8]) {
        // в кавычках — само имя (так шлют браузеры), в filename* — то же имя по RFC 5987
        let quoted: String = filename.chars().filter(|c| *c != '"' && *c != '\\' && !c.is_control()).collect();
        self.body.extend_from_slice(
            format!(
                "--{}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{quoted}\"; filename*=UTF-8''{}\r\nContent-Type: {content_type}\r\n\r\n",
                self.boundary,
                pct_encode(filename)
            )
            .as_bytes(),
        );
        self.body.extend_from_slice(data);
        self.body.extend_from_slice(b"\r\n");
    }

    fn finish(mut self) -> (String, Vec<u8>) {
        self.body.extend_from_slice(format!("--{}--\r\n", self.boundary).as_bytes());
        (format!("multipart/form-data; boundary={}", self.boundary), self.body)
    }
}

async fn post_multipart(path: &str, token: &str, form: Multipart) -> Result<WaResponse, String> {
    let (ctype, body) = form.finish();
    let resp = media_client()
        .post(api_url(path)?)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .header("Content-Type", ctype)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Whisper Archive недоступен: {e}"))?;
    let status = resp.status().as_u16();
    let bytes = read_limited(resp, MAX_SMALL_BODY).await?;
    Ok(WaResponse {
        status,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

// Бюджет загрузок в архив (аудит F-03): не больше двух одновременно и не больше 30 за 10 минут.
// Даже если в интерфейс попадёт чужой код, он не сможет «залить» архив сотнями треков подряд.
const UPLOAD_PARALLEL: usize = 2;
const UPLOAD_WINDOW: Duration = Duration::from_secs(600);
const UPLOAD_PER_WINDOW: usize = 30;

struct Budget {
    active: usize,
    recent: std::collections::VecDeque<std::time::Instant>,
}

fn budget() -> &'static std::sync::Mutex<Budget> {
    static B: OnceLock<std::sync::Mutex<Budget>> = OnceLock::new();
    B.get_or_init(|| std::sync::Mutex::new(Budget { active: 0, recent: Default::default() }))
}

/// Место в очереди загрузок; освобождается, когда загрузка закончилась (успешно или нет).
struct UploadSlot;

impl Drop for UploadSlot {
    fn drop(&mut self) {
        let mut b = budget().lock().unwrap_or_else(|e| e.into_inner());
        b.active = b.active.saturating_sub(1);
    }
}

fn take_slot(b: &mut Budget, now: std::time::Instant) -> Result<(), String> {
    while b.recent.front().is_some_and(|t| now.duration_since(*t) > UPLOAD_WINDOW) {
        b.recent.pop_front();
    }
    if b.active >= UPLOAD_PARALLEL {
        return Err("В архив уже загружаются два трека — дождись, пока они сохранятся".into());
    }
    if b.recent.len() >= UPLOAD_PER_WINDOW {
        return Err("Слишком много загрузок подряд — попробуй через несколько минут".into());
    }
    b.active += 1;
    b.recent.push_back(now);
    Ok(())
}

fn upload_budget() -> Result<UploadSlot, String> {
    let mut b = budget().lock().unwrap_or_else(|e| e.into_inner());
    take_slot(&mut b, std::time::Instant::now())?;
    Ok(UploadSlot)
}

/// Начатая загрузка: ключ прочитан, id альбома проверен, место в бюджете загрузок занято
/// (освобождается, когда Upload пропадает — после отправки или при ошибке по дороге).
pub struct Upload {
    token: String,
    _slot: UploadSlot,
}

/// Начать загрузку — ДО того, как приложение скачивает трек из своего сервиса: без ключа, с чужим id альбома
/// или при исчерпанном бюджете ничего скачивать не нужно. `cover_len` — размер готовой картинки обложки, если она уже есть.
pub fn begin(album_id: Option<&str>, cover_len: Option<usize>) -> Result<Upload, String> {
    let token = read_token()?;
    if let Some(id) = album_id {
        if !is_uuid(id) {
            return Err("Некорректный id альбома".into());
        }
    }
    if cover_len.is_some_and(|n| n > MAX_COVER_UPLOAD) {
        return Err("Обложка пустая или больше 10 МБ".into());
    }
    Ok(Upload { token, _slot: upload_budget()? })
}

/// Название нового альбома: без управляющих символов, не длиннее 75 знаков, не пустое.
pub fn album_title(raw: Option<&str>) -> Result<String, String> {
    let title = clean_title(raw.unwrap_or(""));
    if title.is_empty() {
        return Err("Не указано название альбома".into());
    }
    Ok(title)
}

/// Файл трека для архива: проверенный формат и имя «<название>.<расширение>».
pub struct TrackFile<'a> {
    pub name: String,
    pub mime: &'static str,
    pub bytes: &'a [u8],
}

impl<'a> TrackFile<'a> {
    /// `None` — формат, который архив не принимает (тогда приложение пишет ошибку своими словами).
    /// Размер проверяется отдельно: `bytes.len() > MAX_TRACK_UPLOAD`.
    pub fn new(stem: &str, bytes: &'a [u8]) -> Option<Self> {
        let (ext, mime) = audio_kind(bytes)?;
        Some(Self { name: format!("{}.{ext}", clean_stem(stem)), mime, bytes })
    }
}

impl Upload {
    /// Добавить трек в свой альбом (POST /api/albums/{id}/tracks; альбом должен принадлежать владельцу ключа).
    pub async fn to_album(self, album_id: &str, track: TrackFile<'_>) -> Result<WaResponse, String> {
        if !is_uuid(album_id) {
            return Err("Некорректный id альбома".into());
        }
        let mut form = Multipart::new();
        form.file("tracks", &track.name, track.mime, track.bytes);
        post_multipart(&format!("/api/albums/{album_id}/tracks"), &self.token, form).await
    }

    /// Новый приватный альбом с обложкой и этим треком (POST /api/albums). `title` — из album_title().
    pub async fn new_album(self, title: &str, cover: &[u8], track: TrackFile<'_>) -> Result<WaResponse, String> {
        if cover.is_empty() || cover.len() > MAX_COVER_UPLOAD {
            return Err("Обложка пустая или больше 10 МБ".into());
        }
        let (cover_file, cover_type) =
            image_kind(cover).ok_or_else(|| "Обложка в неподдерживаемом формате".to_string())?;
        let mut form = Multipart::new();
        form.text("Title", title);
        form.text("Visibility", "private");
        form.file("Cover", cover_file, cover_type, cover);
        form.file("Tracks", &track.name, track.mime, track.bytes);
        post_multipart("/api/albums", &self.token, form).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(clean_stem("AC/DC - Back In Black"), "AC DC - Back In Black");
        assert_eq!(clean_stem("  a:b*c?  "), "a b c");
        assert_eq!(clean_stem("..."), "Трек");
        assert_eq!(pct_encode("Ёлка - Ok.mp3"), "%D0%81%D0%BB%D0%BA%D0%B0%20-%20Ok.mp3");
        assert_eq!(clean_title(&"я".repeat(100)).chars().count(), 75);
    }

    #[test]
    fn multipart_layout() {
        let mut m = Multipart::new();
        m.text("Title", "Альбом");
        m.file("Tracks", "Исп - \"Трек\".mp3", "audio/mpeg", b"DATA");
        let b = m.boundary.clone();
        let (ct, body) = m.finish();
        let s = String::from_utf8(body).unwrap();
        assert_eq!(ct, format!("multipart/form-data; boundary={b}"));
        assert!(s.starts_with(&format!("--{b}\r\nContent-Disposition: form-data; name=\"Title\"\r\n\r\nАльбом\r\n")));
        assert!(s.contains("filename=\"Исп - Трек.mp3\"; filename*=UTF-8''"));
        assert!(s.contains("Content-Type: audio/mpeg\r\n\r\nDATA\r\n"));
        assert!(s.ends_with(&format!("--{b}--\r\n")));
    }

    #[test]
    fn sniff() {
        assert_eq!(audio_kind(b"ID3\x04....").unwrap().0, "mp3");
        assert_eq!(image_kind(&[0xFF, 0xD8, 0xFF, 0xE0]).unwrap().0, "cover.jpg");
        assert!(image_kind(b"GIF89a").is_none());
        assert!(is_uuid("0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert!(api_url("/api/albums/../x").is_err());
    }

    #[test]
    fn upload_budget_limits() {
        let mut b = Budget { active: 0, recent: Default::default() };
        let t0 = std::time::Instant::now();
        assert!(take_slot(&mut b, t0).is_ok());
        assert!(take_slot(&mut b, t0).is_ok());
        assert!(take_slot(&mut b, t0).is_err()); // третья одновременно — нельзя
        b.active = 0;
        for _ in 2..UPLOAD_PER_WINDOW {
            take_slot(&mut b, t0).unwrap();
            b.active = 0;
        }
        assert!(take_slot(&mut b, t0).is_err()); // лимит за окно исчерпан
        assert!(take_slot(&mut b, t0 + UPLOAD_WINDOW + Duration::from_secs(1)).is_ok()); // окно прошло
    }
}
