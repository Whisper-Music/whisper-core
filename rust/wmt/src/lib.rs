//! Темы Whisper (`.wmt`) на Rust — то же, что `core/wmt.js`, для программ с нативным интерфейсом.
//! Формат — docs/WMT-FORMAT.md репозитория whisper-core. Без зависимостей.
//!
//! ```no_run
//! let bytes = std::fs::read("theme.wmt").unwrap();
//! let th = whisper_wmt::open(&bytes).unwrap();
//! let t = th.tokens();                                   // общие для всех приложений цвета, эффекты, шрифты
//! let accent = t.accent.and_then(|c| whisper_wmt::rgba(&c));   // [r, g, b, a] для своего интерфейса
//! let css = th.css("my-app");                            // своя секция, если приложение на веб-интерфейсе
//! let bg = th.background();                              // фон: имя, mime, байты
//! ```
//!
//! Чтение по тем же правилам и с теми же лимитами, что в wmt.js: тема — чужой файл.
//! Правила CSS темы (привязка к стилю, фильтр безопасности, роли) здесь не разбираются — это core/theme-css.js.

mod inflate;
pub mod json;

pub use json::Value;
use std::fmt;

/// Версия формата, которую знает этот крейт (`#WMT 1`).
pub const VERSION: u32 = 1;
pub const MAX_FILE: usize = 64 * 1048576;        // сам файл темы
pub const MAX_BYTES: usize = 80 * 1048576;       // все ресурсы после распаковки
const MAX_TEXT_PART: usize = 4 * 1048576;        // одна текстовая секция
const MAX_ASSETS: usize = 200;
const MAX_ZIP_FILES: usize = 200;
/// Расширения фона в архиве — в этом порядке ищется background.<ext>.
pub const BG_EXT: [&str; 11] = ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "mp4", "webm", "m4v", "mov"];

/// Ошибка чтения темы; line — строка текста темы (0 — не к строке).
#[derive(Debug, Clone, PartialEq)]
pub struct WmtError { pub msg: String, pub line: usize }
impl fmt::Display for WmtError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.line > 0 { write!(f, "{} (строка {})", self.msg, self.line) } else { f.write_str(&self.msg) }
    }
}
impl std::error::Error for WmtError {}
fn err<T>(msg: impl Into<String>, line: usize) -> Result<T, WmtError> { Err(WmtError { msg: msg.into(), line }) }

/// Секция текста темы: `@@ <kind> [name] [encoding]`.
#[derive(Debug, Clone)]
pub struct Section { pub kind: String, pub name: String, pub encoding: String, pub line: usize, pub text: String, pub json: Option<Value> }

/// Ресурс темы: файл из архива или старая секция `@@ asset`.
#[derive(Debug, Clone)]
pub struct Asset { pub name: String, pub mime: &'static str, pub bytes: Vec<u8> }

#[derive(Debug, Clone)]
pub struct Theme {
    pub version: u32,
    pub preamble: Vec<String>,
    pub manifest: Value,
    pub tokens_raw: Value,
    pub sections: Vec<Section>,
    pub assets: Vec<Asset>,
    /// тема пришла архивом (zip)
    pub archive: bool,
    background: Option<String>,
}

impl Theme {
    pub fn id(&self) -> &str { self.manifest.get("id").and_then(Value::as_str).unwrap_or("") }
    pub fn name(&self) -> &str { self.manifest.get("name").and_then(Value::as_str).unwrap_or("") }
    pub fn author(&self) -> &str { self.manifest.get("author").and_then(Value::as_str).unwrap_or("") }
    /// CSS для приложения app (`@@ css <app>`) или None
    pub fn css(&self, app: &str) -> Option<&str> {
        self.sections.iter().find(|s| s.kind == "css" && s.name == app).map(|s| s.text.as_str())
    }
    /// настройки приложения (`@@ settings <app>`) или None
    pub fn settings(&self, app: &str) -> Option<&Value> {
        self.sections.iter().find(|s| s.kind == "settings" && s.name == app).and_then(|s| s.json.as_ref())
    }
    /// ресурс по имени или по ссылке «asset:имя»
    pub fn asset(&self, r: &str) -> Option<&Asset> {
        let n = r.strip_prefix("asset:").unwrap_or(r);
        self.assets.iter().find(|a| a.name == n)
    }
    /// фон темы (background.* из архива или старый tokens.background) или None
    pub fn background(&self) -> Option<&Asset> { self.background.as_deref().and_then(|n| self.asset(n)) }
    /// общие значения tokens уже проверенными (как читают их приложения Whisper)
    pub fn tokens(&self) -> Tokens { Tokens::from_value(&self.tokens_raw) }
    /// роли [data-w="…"], которые тема использует в общей секции и (если дана) в секции приложения
    pub fn roles_used(&self, app: Option<&str>) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for sec in ["whisper-core"].into_iter().chain(app) {
            let css = strip_comments(self.css(sec).unwrap_or(""));
            let mut rest = css.as_str();
            while let Some(p) = rest.find("data-w") {
                rest = &rest[p + 6..];
                let t = rest.trim_start();
                let Some(t) = t.strip_prefix('=') else { continue };
                let t = t.trim_start();
                let (q, t) = match t.chars().next() { Some(c @ ('"' | '\'')) => (Some(c), &t[1..]), _ => (None, t) };
                let end = t.find(|c: char| match q { Some(q) => c == q, None => c == ']' || c.is_whitespace() }).unwrap_or(t.len());
                let r = t[..end].trim();
                if !r.is_empty() && r.len() <= 81 && r.starts_with(|c: char| c.is_ascii_lowercase())
                    && r.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || ".:-".contains(c)) && !out.iter().any(|x| x == r) {
                    out.push(r.to_string());
                }
            }
        }
        out.sort();
        out
    }
}

fn strip_comments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(p) = rest.find("/*") {
        out.push_str(&rest[..p]);
        rest = match rest[p + 2..].find("*/") { Some(e) => &rest[p + 2 + e + 2..], None => "" };
    }
    out.push_str(rest);
    out
}

// ---------- tokens ----------

/// Общие значения темы для всех приложений: цвета, эффекты, шрифты. Всё уже проверено:
/// accent/accent2 — строго `#rrggbb`, остальное — безопасные значения CSS, числа обрезаны по границам.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Tokens {
    pub accent: Option<String>,
    pub accent2: Option<String>,
    pub text: Option<String>,
    pub muted: Option<String>,
    pub background: Option<String>,
    /// свечение, px (0–48)
    pub glow: Option<f64>,
    /// непрозрачность панелей (0.2–1)
    pub panel_opacity: Option<f64>,
    /// затемнение фоновой картинки (0–0.85)
    pub dim: Option<f64>,
    /// размытие фона, px (0–48)
    pub background_blur: Option<f64>,
    pub font_body: Option<String>,
    pub font_display: Option<String>,
}

/// Значение CSS из чужого файла (как cssVal в theme-css.js): ≤300 символов, без ; { } < > \ /* url( expression.
pub fn css_value(v: &str) -> Option<String> {
    let l = v.to_ascii_lowercase();
    let bad = v.chars().count() > 300 || v.contains(|c| ";{}<>\\".contains(c)) || v.contains("/*")
        || l.replace(char::is_whitespace, "").contains("url(") || l.contains("expression");
    if bad || v.trim().is_empty() { None } else { Some(v.trim().to_string()) }
}
fn is_hex6(s: &str) -> bool { s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit()) }

impl Tokens {
    pub fn from_value(t: &Value) -> Tokens {
        let s = |p: &str| t.path(p).and_then(Value::as_str);
        let hex = |p: &str| s(p).filter(|v| is_hex6(v)).map(|v| v.to_ascii_lowercase());
        let css = |p: &str| s(p).and_then(css_value);
        let num = |p: &str, lo: f64, hi: f64| t.path(p).and_then(Value::as_f64).filter(|n| n.is_finite()).map(|n| n.clamp(lo, hi));
        Tokens {
            accent: hex("color.accent"), accent2: hex("color.accent2"),
            text: css("color.text"), muted: css("color.muted"), background: css("color.background"),
            glow: num("effects.glow", 0.0, 48.0), panel_opacity: num("effects.panelOpacity", 0.2, 1.0),
            dim: num("effects.dim", 0.0, 0.85), background_blur: num("effects.backgroundBlur", 0.0, 48.0),
            font_body: css("font.body"), font_display: css("font.display"),
        }
    }
}

/// Цвет CSS в [r, g, b, a] для нативного интерфейса: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() с числами.
/// Остальное (имена цветов, hsl, var(), градиенты) — None: приложение берёт свой цвет.
pub fn rgba(c: &str) -> Option<[u8; 4]> {
    let c = c.trim();
    if let Some(h) = c.strip_prefix('#') {
        if !h.chars().all(|x| x.is_ascii_hexdigit()) { return None; }
        let d = |i: usize, n: usize| u8::from_str_radix(&h[i..i + n], 16).ok().map(|v| if n == 1 { v * 17 } else { v });
        return match h.len() {
            3 => Some([d(0, 1)?, d(1, 1)?, d(2, 1)?, 255]),
            4 => Some([d(0, 1)?, d(1, 1)?, d(2, 1)?, d(3, 1)?]),
            6 => Some([d(0, 2)?, d(2, 2)?, d(4, 2)?, 255]),
            8 => Some([d(0, 2)?, d(2, 2)?, d(4, 2)?, d(6, 2)?]),
            _ => None,
        };
    }
    let l = c.to_ascii_lowercase();
    let inner = l.strip_prefix("rgba(").or_else(|| l.strip_prefix("rgb("))?.strip_suffix(')')?;
    let parts: Vec<&str> = inner.split([',', '/', ' ']).filter(|p| !p.is_empty()).collect();
    if parts.len() < 3 || parts.len() > 4 { return None; }
    let ch = |p: &str| -> Option<u8> {
        if let Some(pc) = p.strip_suffix('%') { pc.parse::<f64>().ok().map(|v| (v.clamp(0.0, 100.0) / 100.0 * 255.0).round() as u8) }
        else { p.parse::<f64>().ok().map(|v| v.clamp(0.0, 255.0).round() as u8) }
    };
    let a = match parts.get(3) {
        None => 255,
        Some(p) => match p.strip_suffix('%') {
            Some(pc) => (pc.parse::<f64>().ok()?.clamp(0.0, 100.0) / 100.0 * 255.0).round() as u8,
            None => (p.parse::<f64>().ok()?.clamp(0.0, 1.0) * 255.0).round() as u8,
        },
    };
    Some([ch(parts[0])?, ch(parts[1])?, ch(parts[2])?, a])
}

// ---------- текст темы ----------

fn mime_of(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp",
        "avif" => "image/avif", "bmp" => "image/bmp", "svg" => "image/svg+xml", "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm", "mov" => "video/quicktime", "woff2" => "font/woff2", "woff" => "font/woff",
        "ttf" => "font/ttf", "otf" => "font/otf", "json" => "application/json", "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}
/// имя ресурса: [A-Za-z0-9_.-]{1,100}
pub fn name_ok(n: &str) -> bool { !n.is_empty() && n.len() <= 100 && n.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)) }
/// id темы: [a-z0-9][a-z0-9-]{0,47}
pub fn id_ok(n: &str) -> bool {
    !n.is_empty() && n.len() <= 48 && n.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}
fn word_ok(w: &str) -> bool {
    w.starts_with(|c: char| c.is_ascii_lowercase()) && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn b64(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut n, mut pad) = (0u32, 0u32, 0usize);
    for c in text.bytes().filter(|c| !c.is_ascii_whitespace()) {
        let v = match c {
            b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62, b'/' => 63,
            b'=' => { pad += 1; continue; }
            _ => return None,
        };
        if pad > 0 { return None; }                                   // данные после «=»
        acc = (acc << 6) | v as u32; n += 6;
        if n >= 8 { n -= 8; out.push((acc >> n) as u8); }
    }
    if pad > 2 { None } else { Some(out) }
}

fn json_of(text: &str, what: &str, line: usize) -> Result<Value, WmtError> {
    json::parse(text).map_err(|e| WmtError { msg: format!("Секция «{what}»: ошибка в JSON — {}", e.msg), line: line + e.line })
}

/// Разобрать текст .wmt (без архива).
pub fn parse(text: &str) -> Result<Theme, WmtError> {
    if text.len() as f64 > MAX_FILE as f64 * 1.4 { return err("Файл темы слишком большой", 0); }
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let mut k = 0;
    while k < lines.len() && lines[k].trim().is_empty() { k += 1; }
    let first = lines.get(k).copied().unwrap_or("");
    let version = first.strip_prefix("#WMT").filter(|r| r.starts_with([' ', '\t'])).and_then(|r| {
        let r = r.trim_start_matches([' ', '\t']);
        let d: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
        // как «(\d+)(?:\.(\d+))?\b» в wmt.js: дробная часть необязательна, поэтому решает символ сразу после целого номера
        let after = &r[d.len()..];
        if d.is_empty() || after.starts_with(|c: char| c.is_alphanumeric() || c == '_') { None } else { d.parse::<u32>().ok() }
    });
    let Some(version) = version else { return err("Это не файл темы: первая строка должна быть «#WMT 1»", k + 1) };
    if version > VERSION {
        return err(format!("Тема сделана для более новой версии формата (WMT {version}). Обнови приложение"), k + 1);
    }

    let mut preamble = Vec::new();
    let mut sections: Vec<Section> = Vec::new();
    let mut bodies: Vec<Vec<&str>> = Vec::new();
    for (i, line) in lines.iter().enumerate().skip(k + 1) {
        if let Some(rest) = line.strip_prefix("@@") {
            let words: Vec<&str> = rest.split([' ', '\t']).filter(|w| !w.is_empty()).collect();
            if !rest.starts_with([' ', '\t']) || words.is_empty() || words.len() > 3 || !word_ok(words[0]) {
                return err(format!("Непонятный заголовок секции: «{}»", line.chars().take(60).collect::<String>()), i + 1);
            }
            sections.push(Section {
                kind: words[0].to_string(), name: words.get(1).unwrap_or(&"").to_string(),
                encoding: words.get(2).unwrap_or(&"").to_ascii_lowercase(), line: i + 1, text: String::new(), json: None,
            });
            bodies.push(Vec::new());
        } else if let Some(b) = bodies.last_mut() { b.push(line); } else { preamble.push(line.to_string()); }
    }
    for (s, mut b) in sections.iter_mut().zip(bodies) {
        while b.last().is_some_and(|l| l.trim().is_empty()) { b.pop(); }
        s.text = b.join("\n");
        if s.kind != "asset" && s.text.len() > MAX_TEXT_PART {
            return err(format!("Секция «{}» слишком большая (больше {} МБ текста)", s.kind, MAX_TEXT_PART / 1048576), s.line);
        }
    }
    if sections.len() > MAX_ASSETS + 20 { return err("В теме слишком много секций", 0); }

    let one = |kind: &str| -> Result<Option<&Section>, WmtError> {
        let mut it = sections.iter().filter(|s| s.kind == kind);
        let a = it.next();
        if let Some(b) = it.next() { return err(format!("Секция «{kind}» встречается дважды"), b.line); }
        Ok(a)
    };
    let Some(ms) = one("manifest")? else { return err("В теме нет секции «@@ manifest»", 0) };
    let manifest = json_of(&ms.text, "manifest", ms.line)?;
    if !manifest.is_object() { return err("manifest должен быть объектом { … }", ms.line); }
    let id = manifest.get("id").and_then(Value::as_str).unwrap_or("");
    if !id_ok(id) { return err("manifest.id: латинские буквы в нижнем регистре, цифры и дефис, например «my-dark-gold»", ms.line); }
    if manifest.get("name").and_then(Value::as_str).map_or(true, |n| n.trim().is_empty()) {
        return err("manifest.name: нужно название темы", ms.line);
    }
    let tokens = match one("tokens")? {
        Some(ts) => {
            let v = json_of(&ts.text, "tokens", ts.line)?;
            if !v.is_object() { return err("tokens должен быть объектом { … }", ts.line); }
            v
        }
        None => Value::Obj(Vec::new()),
    };

    let mut assets: Vec<Asset> = Vec::new();
    let mut total = 0usize;
    for s in sections.iter_mut() {
        if s.kind == "settings" {
            let what = format!("{} {}", s.kind, s.name);
            s.json = Some(json_of(&s.text, what.trim(), s.line)?);
        }
        if s.kind != "asset" { continue; }
        if !name_ok(&s.name) { return err("Имя ресурса: буквы, цифры, точка, дефис, подчёркивание", s.line); }
        if assets.len() >= MAX_ASSETS { return err(format!("В теме больше {MAX_ASSETS} ресурсов"), s.line); }
        if assets.iter().any(|a| a.name == s.name) { return err(format!("Ресурс «{}» встречается дважды", s.name), s.line); }
        let bytes = match s.encoding.as_str() {
            "base64" => b64(&s.text).ok_or_else(|| WmtError { msg: format!("Ресурс «{}»: повреждённый base64", s.name), line: s.line })?,
            "" | "text" => s.text.as_bytes().to_vec(),
            e => return err(format!("Ресурс «{}»: неизвестная кодировка «{e}» (нужно base64 или text)", s.name), s.line),
        };
        total += bytes.len();
        if total > MAX_BYTES { return err(format!("Ресурсы темы больше {} МБ", MAX_BYTES / 1048576), 0); }
        assets.push(Asset { name: s.name.clone(), mime: mime_of(&s.name), bytes });
    }
    // старые текстовые темы: фон через tokens.background.{video|image} = "asset:…"
    let background = ["background.video", "background.image"].iter()
        .find_map(|p| tokens.path(p).and_then(Value::as_str))
        .map(|r| r.strip_prefix("asset:").unwrap_or(r).to_string())
        .filter(|n| assets.iter().any(|a| &a.name == n));
    Ok(Theme { version, preamble, manifest, tokens_raw: tokens, sections, assets, archive: false, background })
}

// ---------- архив ----------

fn u16le(b: &[u8], p: usize) -> usize { u16::from_le_bytes([b[p], b[p + 1]]) as usize }
fn u32le(b: &[u8], p: usize) -> u32 { u32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]) }

fn crc32(b: &[u8]) -> u32 {
    let mut t = [0u32; 256];
    for (n, x) in t.iter_mut().enumerate() {
        let mut c = n as u32;
        for _ in 0..8 { c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 }; }
        *x = c;
    }
    !b.iter().fold(!0u32, |c, &x| t[((c ^ x as u32) & 0xff) as usize] ^ (c >> 8))
}

/// zip, переименованный в .wmt? (по подписи PK\x03\x04)
pub fn is_zip(b: &[u8]) -> bool { b.len() > 22 && b[..4] == [0x50, 0x4b, 3, 4] }

/// Файлы архива темы: [(имя, байты)] — с проверками и лимитами wmt.js.
pub fn unzip(b: &[u8]) -> Result<Vec<(String, Vec<u8>)>, WmtError> {
    if b.len() > MAX_FILE { return err(format!("Файл темы больше {} МБ", MAX_FILE / 1048576), 0); }
    if b.len() < 22 { return err("Архив темы повреждён (не найдено оглавление zip)", 0); }
    let lo = b.len().saturating_sub(65557);
    let Some(e) = (lo..=b.len() - 22).rev().find(|&p| u32le(b, p) == 0x0605_4b50) else {
        return err("Архив темы повреждён (не найдено оглавление zip)", 0);
    };
    let count = u16le(b, e + 10);
    let cd_size = u32le(b, e + 12) as usize;
    let mut p = u32le(b, e + 16) as usize;
    let cd_start = p;
    if count > MAX_ZIP_FILES { return err("В архиве темы слишком много файлов", 0); }
    if p + cd_size > e || p > b.len() { return err("Архив темы повреждён (оглавление за пределами файла)", 0); }
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut total = 0usize;
    for _ in 0..count {
        if p + 46 > b.len() || u32le(b, p) != 0x0201_4b50 { return err("Архив темы повреждён (оглавление)", 0); }
        let flags = u16le(b, p + 8);
        let method = u16le(b, p + 10);
        let crc = u32le(b, p + 16);
        let (csize, size) = (u32le(b, p + 20), u32le(b, p + 24));
        let (nl, xl, cl) = (u16le(b, p + 28), u16le(b, p + 30), u16le(b, p + 32));
        let off = u32le(b, p + 42) as usize;
        if p + 46 + nl + xl + cl > b.len() { return err("Архив темы повреждён (запись оглавления обрезана)", 0); }
        let name = String::from_utf8_lossy(&b[p + 46..p + 46 + nl]).replace('\\', "/");
        p += 46 + nl + xl + cl;
        if name.ends_with('/') || name.split('/').any(|s| s.starts_with("__MACOSX") || s.starts_with(".DS_Store")) { continue; }
        if flags & 1 != 0 { return err(format!("Файл «{name}» в архиве зашифрован — такие темы не поддерживаются"), 0); }
        if csize == u32::MAX || size == u32::MAX { return err("Архивы больше 4 ГБ (zip64) не поддерживаются", 0); }
        if files.iter().any(|(n, _)| *n == name) { return err(format!("В архиве темы два файла с именем «{name}»"), 0); }
        let (csize, size) = (csize as usize, size as usize);
        total += size;
        if total > MAX_BYTES { return err(format!("Файлы в архиве темы больше {} МБ", MAX_BYTES / 1048576), 0); }
        if off + 30 > b.len() || u32le(b, off) != 0x0403_4b50 { return err(format!("Архив темы повреждён (файл «{name}»)"), 0); }
        let start = off + 30 + u16le(b, off + 26) + u16le(b, off + 28);
        let end = start + csize;
        if end > b.len() || end > cd_start { return err(format!("Архив темы повреждён (данные «{name}» за пределами файла)"), 0); }
        let raw = &b[start..end];
        let data = match method {
            0 => {
                if csize != size { return err(format!("Архив темы повреждён (размер «{name}» не сходится)"), 0); }
                raw.to_vec()
            }
            8 => match inflate::inflate(raw, size, size) {
                Ok(d) => d,
                Err(inflate::InflateError::TooBig) => return err(format!("Архив темы повреждён: файл «{name}» распаковывается в больший размер, чем заявлено"), 0),
                Err(_) => return err(format!("Архив темы повреждён (не распаковывается «{name}»)"), 0),
            },
            _ => return err(format!("Файл «{name}» сжат неподдерживаемым способом — сохрани архив как обычный zip"), 0),
        };
        if data.len() != size { return err(format!("Архив темы повреждён: размер «{name}» не совпадает с заявленным"), 0); }
        if crc32(&data) != crc { return err(format!("Архив темы повреждён: контрольная сумма «{name}» не сходится"), 0); }
        files.push((name, data));
    }
    Ok(files)
}

/// Открыть тему из файла: текст .wmt или архив (zip, переименованный в .wmt).
pub fn open(bytes: &[u8]) -> Result<Theme, WmtError> {
    if bytes.len() > MAX_FILE { return err(format!("Файл темы больше {} МБ", MAX_FILE / 1048576), 0); }
    if !is_zip(bytes) { return parse(&String::from_utf8_lossy(bytes)); }
    let files = unzip(bytes)?;
    let is_main = |n: &str| { let l = n.to_ascii_lowercase(); l == "theme.wmt" || l.ends_with("/theme.wmt") };
    let main = files.iter().position(|(n, _)| is_main(n))
        .or_else(|| files.iter().position(|(n, _)| n.to_ascii_lowercase().ends_with(".wmt")));
    let Some(main) = main else { return err("В архиве нет файла theme.wmt", 0) };
    let (mname, mtext) = &files[main];
    let dir = &mname[..mname.rfind('/').map_or(0, |i| i + 1)];
    if mtext.len() > MAX_FILE { return err("Текст темы в архиве слишком большой", 0); }
    let mut th = parse(&String::from_utf8_lossy(mtext))?;
    th.archive = true;
    for (i, (n, data)) in files.iter().enumerate() {
        if i == main || !n.starts_with(dir) { continue; }
        let name = &n[dir.len()..];
        if !name_ok(name) { continue; }                               // вложенные папки и странные имена не используются
        let a = Asset { name: name.to_string(), mime: mime_of(name), bytes: data.clone() };
        match th.assets.iter_mut().find(|x| x.name == name) { Some(x) => *x = a, None => th.assets.push(a) }   // файл архива главнее
    }
    if let Some(ext) = BG_EXT.iter().find(|x| th.assets.iter().any(|a| a.name == format!("background.{x}"))) {
        th.background = Some(format!("background.{ext}"));
    }
    Ok(th)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: &str = "\u{feff}\n#WMT 1.2\n# комментарий\n@@ manifest\n{ \"id\": \"mint\", \"name\": \"Мята\", // c\n}\n@@ tokens\n{ \"color\": { \"accent\": \"#3FB8AF\", \"text\": \"red; }\", \"muted\": \"#999\" },\n  \"effects\": { \"glow\": 99, \"panelOpacity\": 0.1 }, \"font\": { \"body\": \"Tahoma, sans-serif\" } }\n@@ css whisper-core\n/* [data-w=\"skip\"] */ [data-w=\"player\"] [data-w='player.play'] { x: y }\n@@ css my-app\n.a { color: red }\n\n\n@@ settings my-app\n{ \"x\": [1,2,], }\n@@ asset dot.txt text\nhello\n";

    #[test]
    fn text_theme() {
        let th = open(T.as_bytes()).unwrap();
        assert_eq!((th.id(), th.name(), th.version), ("mint", "Мята", 1));
        assert_eq!(th.css("my-app"), Some(".a { color: red }"));
        assert_eq!(th.settings("my-app").and_then(|s| s.get("x")).and_then(Value::as_array).map(|a| a.len()), Some(2));
        assert_eq!(th.asset("asset:dot.txt").map(|a| a.bytes.as_slice()), Some(&b"hello"[..]));
        let t = th.tokens();
        assert_eq!(t.accent.as_deref(), Some("#3fb8af"));
        assert_eq!(t.text, None);                                     // «;» и «}» — не значение CSS
        assert_eq!((t.glow, t.panel_opacity), (Some(48.0), Some(0.2)));
        assert_eq!(th.roles_used(Some("my-app")), vec!["player", "player.play"]);
    }

    #[test]
    fn errors() {
        assert_eq!(parse("hello").unwrap_err().line, 1);
        assert!(parse("#WMT 2\n@@ manifest\n{}").unwrap_err().msg.contains("новой версии"));
        assert!(parse("#WMT 1x\n").is_err());
        let e = parse("#WMT 1\n@@ manifest\n{ \"id\": \"a\",\n \"name\": }\n").unwrap_err();
        assert_eq!(e.line, 4);
        assert!(parse("#WMT 1\n@@ manifest\n{ \"id\": \"Bad\", \"name\": \"x\" }").unwrap_err().msg.contains("manifest.id"));
        assert!(parse("#WMT 1\n@@manifest\n").unwrap_err().msg.contains("Непонятный"));
        assert!(parse("#WMT 1\n@@ manifest\n{\"id\":\"a\",\"name\":\"b\"}\n@@ manifest\n{}").unwrap_err().msg.contains("дважды"));
    }

    #[test]
    fn colors() {
        assert_eq!(rgba("#3fb8af"), Some([0x3f, 0xb8, 0xaf, 255]));
        assert_eq!(rgba("#fff8"), Some([255, 255, 255, 0x88]));
        assert_eq!(rgba("rgba(10, 20, 30, .5)"), Some([10, 20, 30, 128]));
        assert_eq!(rgba("rgb(10 20 30 / 50%)"), Some([10, 20, 30, 128]));
        assert_eq!(rgba("var(--x)"), None);
        assert_eq!(css_value("url (x)"), None);
    }

    #[test]
    fn base64_and_crc() {
        assert_eq!(b64("aGVs\nbG8="), Some(b"hello".to_vec()));
        assert_eq!(b64("aGVs*"), None);
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }
}
