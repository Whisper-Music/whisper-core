// ---------------------------------------------------------------------------
// Потоковое воспроизведение из архива: протокол wa:// (на Windows — http://wa.localhost).
//
// Плеер <audio> не умеет добавлять заголовок Authorization, поэтому раньше трек скачивался целиком
// (30 МБ FLAC ≈ 3 с) и только потом начинал играть. Теперь <audio src="wa://localhost/track/<id>">
// запрашивает трек кусками (Range), Rust подставляет ключ и пересылает Range на сервер (он отвечает 206).
// Первый кусок маленький — старт ≈ одного запроса; первые куски следующих треков можно взять заранее.
// Протокол обслуживает только главное окно (проверка в lib.rs), ключ в ответы не попадает.
// ---------------------------------------------------------------------------

use super::*;
use std::sync::Mutex;
use tauri::http::{header, Request, Response, StatusCode};
use tauri_plugin_http::reqwest;

const FIRST_CHUNK: u64 = 512 * 1024; // начало трека: чем меньше, тем быстрее старт
const NEXT_CHUNK: u64 = 2 * 1024 * 1024; // дальше — крупнее, чтобы было меньше запросов
const HEAD_CACHE_MAX: usize = 4; // сколько «начал» треков держать в памяти (≈ 2 МБ)

#[derive(Clone)]
struct Head {
    total: u64,
    ctype: String,
    bytes: Vec<u8>,
}

fn head_cache() -> &'static Mutex<Vec<(String, Head)>> {
    static C: OnceLock<Mutex<Vec<(String, Head)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Vec::new()))
}

fn cache_get(id: &str) -> Option<Head> {
    head_cache().lock().ok()?.iter().find(|(k, _)| k == id).map(|(_, h)| h.clone())
}

fn cache_put(id: &str, h: Head) {
    if let Ok(mut c) = head_cache().lock() {
        c.retain(|(k, _)| k != id);
        c.push((id.to_string(), h));
        while c.len() > HEAD_CACHE_MAX {
            c.remove(0);
        }
    }
}

/// Другой аккаунт или выход — старые куски больше не наши.
pub fn clear_stream_cache() {
    if let Ok(mut c) = head_cache().lock() {
        c.clear();
    }
}

/// «bytes=S-E» / «bytes=S-» -> (S, Some(E) | None). Без заголовка или в непонятном виде — с начала.
pub(crate) fn parse_range(v: Option<&str>) -> (u64, Option<u64>) {
    let Some(spec) = v.and_then(|s| s.trim().strip_prefix("bytes=")) else { return (0, None) };
    let first = spec.split(',').next().unwrap_or("").trim();
    let Some((a, b)) = first.split_once('-') else { return (0, None) };
    let start = a.trim().parse::<u64>().unwrap_or(0);
    let end = b.trim().parse::<u64>().ok().filter(|e| *e >= start);
    (start, end)
}

/// «bytes S-E/TOTAL» -> (S, TOTAL)
fn parse_content_range(v: &str) -> Option<(u64, u64)> {
    let rest = v.trim().strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let (s, _) = range.split_once('-')?;
    Some((s.trim().parse().ok()?, total.trim().parse().ok()?))
}

struct Chunk {
    status: u16,
    start: u64,
    total: Option<u64>,
    ctype: String,
    bytes: Vec<u8>,
}

async fn fetch_range(id: &str, token: &str, start: u64, end: u64) -> Result<Chunk, String> {
    let resp = json_client()
        .get(api_url(&format!("/api/tracks/{id}/stream"))?)
        .header("Authorization", format!("Bearer {token}"))
        .header("Range", format!("bytes={start}-{end}"))
        .send()
        .await
        .map_err(|e| format!("Whisper Archive недоступен: {e}"))?;
    let status = resp.status().as_u16();
    let h = resp.headers();
    let ctype = h
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.starts_with("audio/") || *v == "application/octet-stream")
        .unwrap_or("audio/mpeg")
        .to_string();
    let range = h
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_content_range);
    let want = end - start + 1;
    match status {
        206 => {
            let bytes = read_limited(resp, want as usize).await?;
            // ответ должен быть ровно про запрошенный кусок и не выходить за длину файла:
            // иначе плееру ушли бы противоречивые Content-Range (и куски «склеились» бы не туда)
            let Some((s, total)) = range else { return Err("сервер не прислал Content-Range".into()) };
            if s != start || bytes.is_empty() || s.saturating_add(bytes.len() as u64) > total {
                return Err("сервер прислал не тот кусок трека".into());
            }
            Ok(Chunk { status, start: s, total: Some(total), ctype, bytes })
        }
        // Сервер проигнорировал Range и шлёт файл целиком: не держим в памяти весь трек (до 400 МБ на каждый
        // такой запрос), а пропускаем начало и берём только нужный кусок — дальше это обычный ответ 206.
        200 => {
            let Some(total) = resp.content_length() else {
                // размер неизвестен — как раньше, целиком (но не больше трёх таких загрузок сразу)
                let _slot = host::heavy_slot().await?;
                let all = read_limited(resp, MAX_AUDIO_BODY).await?;
                let total = all.len() as u64;
                if start >= total {
                    return Ok(Chunk { status: 416, start, total: Some(total), ctype, bytes: Vec::new() });
                }
                let to = total.min(start + want) as usize;
                return Ok(Chunk { status: 206, start, total: Some(total), ctype, bytes: all[start as usize..to].to_vec() });
            };
            if total > MAX_AUDIO_BODY as u64 {
                return Err("Ответ слишком большой".into());
            }
            if start >= total {
                return Ok(Chunk { status: 416, start, total: Some(total), ctype, bytes: Vec::new() });
            }
            let bytes = read_slice(resp, start, want).await?;
            if bytes.is_empty() {
                return Err("сервер оборвал передачу".into());
            }
            Ok(Chunk { status: 206, start, total: Some(total), ctype, bytes })
        }
        _ => Ok(Chunk { status, start, total: None, ctype, bytes: Vec::new() }),
    }
}

/// Из тела ответа — только байты [skip, skip + len): остальное читается и сразу выбрасывается.
async fn read_slice(mut resp: reqwest::Response, skip: u64, len: u64) -> Result<Vec<u8>, String> {
    let mut pos = 0u64;
    let mut out = Vec::with_capacity(len.min(NEXT_CHUNK) as usize);
    while (out.len() as u64) < len {
        let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? else { break };
        let c_end = pos + chunk.len() as u64;
        if c_end > skip {
            let from = skip.saturating_sub(pos) as usize;
            let need = (len - out.len() as u64) as usize;
            let to = chunk.len().min(from + need);
            out.extend_from_slice(&chunk[from..to]);
        }
        pos = c_end;
    }
    Ok(out)
}

fn cors(mut b: tauri::http::response::Builder, origin: &Option<String>) -> tauri::http::response::Builder {
    // запрос приходит только из главного окна (lib.rs); CORS нужен визуализатору (анализ звука работает
    // только с CORS-разрешённым источником) — разрешаем ровно Origin приложения, а не любой (аудит F-11)
    if let Some(o) = host::app_origin(origin.as_deref()) {
        b = b.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, o).header(header::VARY, "Origin");
    }
    b
}

fn partial(ctype: &str, start: u64, total: u64, body: Vec<u8>, origin: &Option<String>) -> Response<Vec<u8>> {
    let end = start + body.len() as u64 - 1;
    cors(Response::builder(), origin)
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, ctype)
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"))
        .header(header::CONTENT_LENGTH, body.len())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .unwrap_or_default()
}

fn plain(status: StatusCode, msg: &str, origin: &Option<String>) -> Response<Vec<u8>> {
    cors(Response::builder(), origin)
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(msg.as_bytes().to_vec())
        .unwrap_or_default()
}

/// Обработчик wa://localhost/track/<uuid> (регистрируется в lib.rs).
pub async fn serve_stream(req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let Some(id) = req.uri().path().strip_prefix("/track/").filter(|s| is_uuid(s)).map(str::to_string) else {
        return plain(StatusCode::NOT_FOUND, "not found", &origin);
    };
    let (start, want_end) = parse_range(req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()));
    // файлов больше MAX_AUDIO_BODY не бывает; заодно start + step ниже не переполнится
    if start >= MAX_AUDIO_BODY as u64 {
        return plain(StatusCode::RANGE_NOT_SATISFIABLE, "range", &origin);
    }

    // начало трека, взятое заранее, — отдаём сразу, без сети
    if start == 0 {
        if let Some(h) = cache_get(&id) {
            let n = h.bytes.len() as u64;
            let end = want_end.map(|e| e.min(n - 1)).unwrap_or(n - 1);
            return partial(&h.ctype, 0, h.total, h.bytes[..=end as usize].to_vec(), &origin);
        }
    }

    let token = match read_token() {
        Ok(t) => t,
        Err(e) => return plain(StatusCode::UNAUTHORIZED, &e, &origin),
    };
    let step = if start == 0 { FIRST_CHUNK } else { NEXT_CHUNK };
    let end = want_end.map(|e| e.min(start + step - 1)).unwrap_or(start + step - 1);
    let c = match fetch_range(&id, &token, start, end).await {
        Ok(c) => c,
        Err(e) => return plain(StatusCode::BAD_GATEWAY, &e, &origin),
    };
    match c.status {
        206 if !c.bytes.is_empty() => {
            let Some(total) = c.total else {
                return plain(StatusCode::BAD_GATEWAY, "нет Content-Range", &origin);
            };
            if c.start == 0 {
                cache_put(&id, Head { total, ctype: c.ctype.clone(), bytes: c.bytes.clone() });
            }
            partial(&c.ctype, c.start, total, c.bytes, &origin)
        }
        // сервер вдруг отдал файл целиком — отдаём как есть
        200 => cors(Response::builder(), &origin)
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, c.ctype.as_str())
            .header(header::CONTENT_LENGTH, c.bytes.len())
            .header(header::CACHE_CONTROL, "no-store")
            .body(c.bytes)
            .unwrap_or_default(),
        416 => plain(StatusCode::RANGE_NOT_SATISFIABLE, "range", &origin),
        401 | 403 => plain(StatusCode::UNAUTHORIZED, "ключ не принят", &origin),
        404 => plain(StatusCode::NOT_FOUND, "трека нет в архиве", &origin),
        s => plain(StatusCode::BAD_GATEWAY, &format!("HTTP {s}"), &origin),
    }
}

/// Заранее взять начало трека (следующего в очереди): тогда он стартует без ожидания сети.
#[tauri::command]
pub async fn wa_prefetch(id: String) -> Result<(), String> {
    if !is_uuid(&id) {
        return Err("Некорректный id трека".into());
    }
    if cache_get(&id).is_some() {
        return Ok(());
    }
    let token = read_token()?;
    let c = fetch_range(&id, &token, 0, FIRST_CHUNK - 1).await?;
    if c.status == 206 && c.start == 0 && !c.bytes.is_empty() {
        if let Some(total) = c.total {
            cache_put(&id, Head { total, ctype: c.ctype, bytes: c.bytes });
        }
    }
    Ok(())
}

#[cfg(test)]
mod stream_tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range(Some("bytes=0-")), (0, None));
        assert_eq!(parse_range(Some("bytes=100-199")), (100, Some(199)));
        assert_eq!(parse_range(Some("bytes=500-100")), (500, None));
        assert_eq!(parse_range(None), (0, None));
        assert_eq!(parse_content_range("bytes 0-524287/30511652"), Some((0, 30511652)));
        assert_eq!(parse_content_range("bytes */100"), None);
    }

    /// Проверка на настоящем сервере (публичный трек, без ключа):
    /// WA_TEST_TRACK=<uuid> cargo test --lib live_stream -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_stream() {
        let id = std::env::var("WA_TEST_TRACK").expect("WA_TEST_TRACK");
        tauri::async_runtime::block_on(async {
            let t0 = std::time::Instant::now();
            let a = fetch_range(&id, "", 0, FIRST_CHUNK - 1).await.unwrap();
            let t1 = t0.elapsed();
            let b = fetch_range(&id, "", FIRST_CHUNK, FIRST_CHUNK + NEXT_CHUNK - 1).await.unwrap();
            let t2 = t0.elapsed() - t1;
            println!("first: {} {}B start={} total={:?} {} in {:?}", a.status, a.bytes.len(), a.start, a.total, a.ctype, t1);
            println!("next:  {} {}B start={} in {:?}", b.status, b.bytes.len(), b.start, t2);
            assert_eq!(a.status, 206);
            assert_eq!(a.bytes.len() as u64, FIRST_CHUNK);
            assert_eq!(b.start, FIRST_CHUNK);
            assert!(a.total.unwrap() > FIRST_CHUNK);
        });
    }
}
