"use strict";
// Whisper Music Theme (.wmt) — разбор и сборка файла темы. Описание формата: docs/WMT-FORMAT.md.
// Часть ядра Whisper (core/): модуль не зависит от приложения — общий для всех программ Whisper (браузер или Node).
// Привязка CSS темы к стилю и фильтр безопасности — core/theme-css.js.
//
// Тема бывает двух видов (как у Telegram Desktop):
// * просто текстовый файл .wmt — цвета, шрифты, CSS; фона нет;
// * архив: zip, переименованный в .wmt, внутри theme.wmt (тот же текст) + background.jpg/png/webp/mp4… + что угодно ещё
//   (preview.png, шрифты). Картинки не раздувают текст темы, а фон всегда называется background.<расширение>.
// open() понимает оба вида, pack() собирает архив.
//
// Текст темы — UTF-8, который удобно править в любом редакторе:
//
//   #WMT 1
//   # строки с «#» до первой секции — комментарии
//   @@ manifest            ← JSON: кто, что, на чём основан
//   { ... }
//   @@ tokens              ← JSON: общие для всех программ цвета, эффекты, шрифты, фон
//   { ... }
//   @@ css whisper-music   ← CSS для конкретной программы (каждая читает только свою секцию)
//   .panel { ... }
//   @@ settings whisper-music   ← JSON: настройки конкретной программы
//   { ... }
//   @@ asset background.jpg base64   ← картинка, видео или шрифт внутри файла
//   /9j/4AAQSkZJRg...
//
// В JSON-секциях можно оставлять комментарии // и /* */, а также лишние запятые — как в настройках VS Code.
(function (root) {
  const VERSION = 1;
  // Лимиты для тем из чужих рук (аудит F-07): раньше было 300 МБ файла и 256 МБ ресурсов — с копиями при
  // распаковке это давало сотни мегабайт пиковой памяти. Тема — оформление, ей хватает десятков мегабайт.
  // Общий бюджет: файл (сжатый) + распакованные ресурсы не больше MAX_FILE + MAX_BYTES; при распаковке
  // каждый файл пишется сразу в итоговый буфер, без промежуточных копий.
  const MAX_BYTES = 80 * 1048576;            // все ресурсы темы после распаковки
  const MAX_FILE = 64 * 1048576;             // сам файл темы (текст или архив) — единый лимит для всех способов импорта
  const MAX_TEXT_PART = 4 * 1048576;         // одна несекционная часть: manifest, tokens, settings, css
  const MAX_ASSETS = 200;
  const MAX_ZIP_FILES = 200;
  const NAME_RE = /^[\w.-]{1,100}$/;
  const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
  const HEADER_RE = /^@@[ \t]+([a-z][\w-]*)(?:[ \t]+(\S+))?(?:[ \t]+(\S+))?[ \t]*$/;
  const JSON_TYPES = new Set(["manifest", "tokens", "settings"]);
  const MIME = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
    bmp: "image/bmp", svg: "image/svg+xml", mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf", json: "application/json", txt: "text/plain",
  };
  const mimeOf = (name) => MIME[String(name).split(".").pop().toLowerCase()] || "application/octet-stream";

  class WmtError extends Error {
    constructor(msg, line) { super(line ? `${msg} (строка ${line})` : msg); this.name = "WmtError"; this.line = line || 0; }
  }

  // JSON с комментариями и лишними запятыми -> обычный JSON
  function stripJsonc(s) {
    let out = "", i = 0, str = false;
    while (i < s.length) {
      const c = s[i], n = s[i + 1];
      if (str) {
        out += c;
        if (c === "\\") { out += n ?? ""; i += 2; continue; }
        if (c === '"') str = false;
        i++; continue;
      }
      if (c === '"') { str = true; out += c; i++; continue; }
      if (c === "/" && n === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
      if (c === "/" && n === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) { out += s[i] === "\n" ? "\n" : ""; i++; } i += 2; continue; }
      out += c; i++;
    }
    // лишние запятые перед } и ] — только вне строк
    let res = "";
    str = false;
    for (let j = 0; j < out.length; j++) {
      const c = out[j];
      if (str) { res += c; if (c === "\\") { res += out[++j] ?? ""; } else if (c === '"') str = false; continue; }
      if (c === '"') { str = true; res += c; continue; }
      if (c === ",") { let q = j + 1; while (q < out.length && /\s/.test(out[q])) q++; if (out[q] === "}" || out[q] === "]") continue; }
      res += c;
    }
    return res;
  }
  function parseJson(text, what, line) {
    try { return JSON.parse(stripJsonc(text)); }
    catch (e) {
      // номер строки — по всему файлу: заголовок секции + строка внутри JSON (если движок её сообщает)
      const m = /line (\d+)/i.exec(e.message) || null;
      let at = m ? line + +m[1] : line;
      if (!m) { const p = /position (\d+)/i.exec(e.message); if (p) at = line + 1 + (stripJsonc(text).slice(0, +p[1]).match(/\n/g) || []).length; }
      throw new WmtError(`Секция «${what}»: ошибка в JSON — ${e.message.replace(/\s*\(line \d+ column \d+\)/i, "")}`, at);
    }
  }

  function b64decode(text) {
    const clean = text.replace(/\s+/g, "");
    if (typeof Buffer !== "undefined" && typeof atob === "undefined") return new Uint8Array(Buffer.from(clean, "base64"));
    const bin = atob(clean), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function b64encode(bytes, width = 76) {
    let s;
    if (typeof Buffer !== "undefined" && typeof btoa === "undefined") s = Buffer.from(bytes).toString("base64");
    else {
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      s = btoa(bin);
    }
    const lines = [];
    for (let i = 0; i < s.length; i += width) lines.push(s.slice(i, i + width));
    return lines.join("\n");
  }

  /**
   * Разобрать текст .wmt.
   * Возвращает { version, preamble, manifest, tokens, sections, assets, css(app), settings(app), asset(ref) }.
   * Бросает WmtError с номером строки, если файл не похож на тему или в нём ошибка.
   */
  function parse(text) {
    if (typeof text !== "string") throw new WmtError("Нет текста темы");
    if (text.length > MAX_FILE * 1.4) throw new WmtError("Файл темы слишком большой");
    const lines = text.replace(/^﻿/, "").split(/\r?\n/);
    let k = 0;
    while (k < lines.length && !lines[k].trim()) k++;
    const m = /^#WMT[ \t]+(\d+)(?:\.(\d+))?\b/.exec(lines[k] || "");
    if (!m) throw new WmtError("Это не файл темы: первая строка должна быть «#WMT 1»", k + 1);
    const version = +m[1];
    if (version > VERSION) throw new WmtError(`Тема сделана для более новой версии формата (WMT ${version}). Обнови приложение`, k + 1);

    const preamble = [], sections = [];
    let cur = null;
    for (let i = k + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("@@")) {
        const h = HEADER_RE.exec(line);
        if (!h) throw new WmtError(`Непонятный заголовок секции: «${line.slice(0, 60)}»`, i + 1);
        cur = { type: h[1], name: h[2] || "", encoding: (h[3] || "").toLowerCase(), line: i + 1, body: [] };
        sections.push(cur);
      } else if (cur) cur.body.push(line);
      else preamble.push(line);
    }
    for (const s of sections) {
      while (s.body.length && !s.body[s.body.length - 1].trim()) s.body.pop();
      s.text = s.body.join("\n");
      delete s.body;
      if (s.type !== "asset" && s.text.length > MAX_TEXT_PART) throw new WmtError(`Секция «${s.type}» слишком большая (больше ${MAX_TEXT_PART / 1048576} МБ текста)`, s.line);
    }
    if (sections.length > MAX_ASSETS + 20) throw new WmtError("В теме слишком много секций");

    const one = (type) => {
      const list = sections.filter((s) => s.type === type);
      if (list.length > 1) throw new WmtError(`Секция «${type}» встречается дважды`, list[1].line);
      return list[0];
    };
    const ms = one("manifest");
    if (!ms) throw new WmtError("В теме нет секции «@@ manifest»");
    const manifest = parseJson(ms.text, "manifest", ms.line);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new WmtError("manifest должен быть объектом { … }", ms.line);
    if (!ID_RE.test(String(manifest.id || ""))) throw new WmtError("manifest.id: латинские буквы в нижнем регистре, цифры и дефис, например «my-dark-gold»", ms.line);
    if (typeof manifest.name !== "string" || !manifest.name.trim()) throw new WmtError("manifest.name: нужно название темы", ms.line);

    const ts = one("tokens");
    const tokens = ts ? parseJson(ts.text, "tokens", ts.line) : {};
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) throw new WmtError("tokens должен быть объектом { … }", ts.line);

    const assets = new Map();
    let total = 0;
    for (const s of sections) {
      if (JSON_TYPES.has(s.type) && s.type !== "manifest" && s.type !== "tokens") s.json = parseJson(s.text, `${s.type} ${s.name}`.trim(), s.line);
      if (s.type !== "asset") continue;
      if (!NAME_RE.test(s.name)) throw new WmtError("Имя ресурса: буквы, цифры, точка, дефис, подчёркивание", s.line);
      if (assets.size >= MAX_ASSETS) throw new WmtError(`В теме больше ${MAX_ASSETS} ресурсов`, s.line);
      if (s.encoding === "base64" && s.text.length > (MAX_BYTES - total) * 1.4 + 16) throw new WmtError(`Ресурсы темы больше ${MAX_BYTES / 1048576} МБ`, s.line);   // до декодирования
      if (assets.has(s.name)) throw new WmtError(`Ресурс «${s.name}» встречается дважды`, s.line);
      let bytes;
      if (s.encoding === "base64") {
        try { bytes = b64decode(s.text); } catch { throw new WmtError(`Ресурс «${s.name}»: повреждённый base64`, s.line); }
      } else if (!s.encoding || s.encoding === "text") bytes = new TextEncoder().encode(s.text);
      else throw new WmtError(`Ресурс «${s.name}»: неизвестная кодировка «${s.encoding}» (нужно base64 или text)`, s.line);
      total += bytes.length;
      if (total > MAX_BYTES) throw new WmtError(`Ресурсы темы больше ${MAX_BYTES / 1048576} МБ`);
      assets.set(s.name, { name: s.name, mime: mimeOf(s.name), bytes });
    }

    const th = {
      version, preamble, manifest, tokens, sections, assets,
      archive: false,
      /** CSS для программы app (или null) */
      css: (app) => sections.find((s) => s.type === "css" && s.name === app)?.text ?? null,
      /** JSON-настройки для программы app (или {}) */
      settings: (app) => sections.find((s) => s.type === "settings" && s.name === app)?.json || {},
      /** ресурс по ссылке «asset:имя» (или null) */
      asset: (ref) => { const n = /^asset:(.+)$/.exec(String(ref || "")); return n ? assets.get(n[1]) || null : null; },
    };
    /** фон темы: файл background.* из архива, иначе (старый способ) tokens.background внутри текста; null — фона нет */
    th.background = th.asset(tokens.background?.video || tokens.background?.image);
    return th;
  }

  // ---------- архив: zip, переименованный в .wmt (как темы Telegram Desktop) ----------
  // Внутри: theme.wmt (текст темы) + background.<расширение> (фон) + по желанию preview.png, шрифты и т.п.
  // Сжатие — стандартный deflate через DecompressionStream / CompressionStream (есть в браузерах и в Node 18+).
  const BG_EXT = ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "mp4", "webm", "m4v", "mov"];
  const isZip = (b) => b.length > 22 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;
  const u16 = (b, p) => b[p] | (b[p + 1] << 8);
  const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  async function streamThrough(bytes, ts) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ts)).arrayBuffer());
  }
  // Распаковка deflate с жёстким потолком прямо во время чтения потока: как только набралось больше заявленного
  // размера (а заявленное в оглавлении zip злоумышленник может подделать), поток обрывается, не дожидаясь конца.
  async function inflateLimited(raw, size, name) {
    const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const out = new Uint8Array(size);        // size уже проверен по общему бюджету MAX_BYTES; куски пишутся сразу сюда
    let n = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (n + value.length > size) {
          reader.cancel().catch(() => {});
          throw new WmtError(`Архив темы повреждён: файл «${name}» распаковывается в больший размер, чем заявлено`);
        }
        out.set(value, n);
        n += value.length;
      }
    } catch (e) {
      if (e instanceof WmtError) throw e;
      throw new WmtError(`Архив темы повреждён (не распаковывается «${name}»)`);
    }
    return n === size ? out : out.subarray(0, n);
  }
  async function unzip(b) {
    if (b.length > MAX_FILE) throw new WmtError(`Файл темы больше ${MAX_FILE / 1048576} МБ`);
    let e = -1;
    for (let p = b.length - 22; p >= Math.max(0, b.length - 65557); p--) if (u32(b, p) === 0x06054b50) { e = p; break; }
    if (e < 0) throw new WmtError("Архив темы повреждён (не найдено оглавление zip)");
    const count = u16(b, e + 10), cdSize = u32(b, e + 12);
    let p = u32(b, e + 16), total = 0;
    const cdStart = p;
    if (count > MAX_ZIP_FILES) throw new WmtError("В архиве темы слишком много файлов");
    if (p + cdSize > e || p > b.length) throw new WmtError("Архив темы повреждён (оглавление за пределами файла)");
    const files = new Map(), dec = new TextDecoder();
    for (let k = 0; k < count; k++) {
      if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw new WmtError("Архив темы повреждён (оглавление)");
      const flags = u16(b, p + 8), method = u16(b, p + 10), crc = u32(b, p + 16), csize = u32(b, p + 20), size = u32(b, p + 24);
      const nl = u16(b, p + 28), xl = u16(b, p + 30), cl = u16(b, p + 32), off = u32(b, p + 42);
      if (p + 46 + nl + xl + cl > b.length) throw new WmtError("Архив темы повреждён (запись оглавления обрезана)");
      const name = dec.decode(b.subarray(p + 46, p + 46 + nl)).replace(/\\/g, "/");
      p += 46 + nl + xl + cl;
      if (name.endsWith("/") || /(^|\/)(__MACOSX|\.DS_Store)/.test(name)) continue;
      if (flags & 1) throw new WmtError(`Файл «${name}» в архиве зашифрован — такие темы не поддерживаются`);
      if (csize === 0xffffffff || size === 0xffffffff) throw new WmtError("Архивы больше 4 ГБ (zip64) не поддерживаются");
      if (files.has(name)) throw new WmtError(`В архиве темы два файла с именем «${name}»`);
      total += size;
      if (total > MAX_BYTES) throw new WmtError(`Файлы в архиве темы больше ${MAX_BYTES / 1048576} МБ`);
      if (off + 30 > b.length || u32(b, off) !== 0x04034b50) throw new WmtError(`Архив темы повреждён (файл «${name}»)`);
      const start = off + 30 + u16(b, off + 26) + u16(b, off + 28), end = start + csize;
      if (end > b.length || end > cdStart) throw new WmtError(`Архив темы повреждён (данные «${name}» за пределами файла)`);
      const raw = b.subarray(start, end);
      let data;
      if (method === 0) {
        if (csize !== size) throw new WmtError(`Архив темы повреждён (размер «${name}» не сходится)`);
        data = raw.slice();
      } else if (method === 8) data = await inflateLimited(raw, size, name);
      else throw new WmtError(`Файл «${name}» сжат неподдерживаемым способом — сохрани архив как обычный zip`);
      if (data.length !== size) throw new WmtError(`Архив темы повреждён: размер «${name}» не совпадает с заявленным`);
      if (crc32(data) !== crc) throw new WmtError(`Архив темы повреждён: контрольная сумма «${name}» не сходится`);
      files.set(name, data);
    }
    return files;
  }
  let CRC = null;
  function crc32(b) {
    if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  async function zip(entries) {
    const enc = new TextEncoder(), parts = [], central = [];
    const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    let offset = 0;
    for (const { name, bytes } of entries) {
      const nb = enc.encode(name), crc = crc32(bytes);
      // уже сжатые картинки и видео кладём как есть, текст сжимаем
      let method = 0, data = bytes;
      if (!/\.(jpe?g|png|webp|gif|avif|mp4|webm|m4v|mov|woff2?)$/i.test(name)) {
        const z = await streamThrough(bytes, new CompressionStream("deflate-raw"));
        if (z.length < bytes.length) { method = 8; data = z; }
      }
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, method, true);
      h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, bytes.length, true); h.setUint16(26, nb.length, true);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, method, true);
      c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, bytes.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, offset, true);
      parts.push(new Uint8Array(h.buffer), nb, data);
      central.push(new Uint8Array(c.buffer), nb);
      offset += 30 + nb.length + data.length;
    }
    const csize = central.reduce((s, x) => s + x.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true);
    e.setUint32(12, csize, true); e.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(e.buffer)], out = new Uint8Array(all.reduce((s, x) => s + x.length, 0));
    let o = 0; for (const x of all) { out.set(x, o); o += x.length; }
    return out;
  }

  /**
   * Открыть тему из файла: текст .wmt или архив (zip, переименованный в .wmt).
   * input — строка, Uint8Array или ArrayBuffer. Возвращает то же, что parse(), плюс archive = true для архива.
   * В архиве файлы доступны как ресурсы по имени («asset:имя», url(asset:имя)); фон — файл background.*.
   */
  async function open(input) {
    if (typeof input === "string") return parse(input);
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (b.length > MAX_FILE) throw new WmtError(`Файл темы больше ${MAX_FILE / 1048576} МБ`);      // до распаковки и декодирования
    if (!isZip(b)) return parse(new TextDecoder().decode(b));
    const files = await unzip(b);
    // архив могли собрать из папки целиком — тогда всё лежит в подпапке; берём папку, где лежит theme.wmt
    const main = [...files.keys()].find((n) => /(^|\/)theme\.wmt$/i.test(n)) || [...files.keys()].find((n) => /\.wmt$/i.test(n));
    if (!main) throw new WmtError("В архиве нет файла theme.wmt");
    const dir = main.slice(0, main.lastIndexOf("/") + 1);
    if (files.get(main).length > MAX_FILE) throw new WmtError("Текст темы в архиве слишком большой");
    const th = parse(new TextDecoder().decode(files.get(main)));
    th.archive = true;
    for (const [n, bytes] of files) {
      if (n === main || !n.startsWith(dir)) continue;
      const name = n.slice(dir.length);
      if (!NAME_RE.test(name)) continue;                         // вложенные папки и странные имена не используются
      th.assets.set(name, { name, mime: mimeOf(name), bytes });  // файл из архива главнее одноимённой секции @@ asset
    }
    const bg = BG_EXT.map((x) => th.assets.get("background." + x)).find(Boolean);
    if (bg) th.background = bg;
    return th;
  }

  /**
   * Собрать архив .wmt: theme.wmt (текст, без двоичных ресурсов) + background.<ext> + остальные файлы.
   * theme — как для serialize(), плюс background?: { ext, bytes } и files?: [{ name, bytes }].
   * Без фона и файлов возвращает просто текст (Uint8Array в UTF-8).
   */
  async function pack(theme) {
    const text = serialize({ ...theme, assets: [] });
    const files = [...(theme.files || [])];
    if (theme.background) {
      const ext = String(theme.background.ext || "").toLowerCase().replace(/^\./, "");
      if (!BG_EXT.includes(ext)) throw new WmtError(`Фон с расширением «${ext}» не поддерживается`);
      files.unshift({ name: "background." + ext, bytes: theme.background.bytes });
    }
    for (const f of files) if (!NAME_RE.test(f.name)) throw new WmtError(`Недопустимое имя файла «${f.name}»`);
    const t = new TextEncoder().encode(text);
    return files.length ? zip([{ name: "theme.wmt", bytes: t }, ...files]) : t;
  }

  /**
   * Собрать текст .wmt.
   * theme: { comment?, manifest, tokens?, css?: {app: text}, settings?: {app: obj}, assets?: [{name, bytes}], extra?: [{type, name, encoding, text}] }
   */
  function serialize(theme) {
    const out = [`#WMT ${VERSION}`];
    for (const c of String(theme.comment || "").split("\n")) if (c.trim()) out.push("# " + c.replace(/^#\s?/, ""));
    out.push("");
    const json = (v) => JSON.stringify(v, null, 2);
    out.push("@@ manifest", json(theme.manifest), "");
    if (theme.tokens && Object.keys(theme.tokens).length) out.push("@@ tokens", json(theme.tokens), "");
    for (const [app, obj] of Object.entries(theme.settings || {})) if (obj && Object.keys(obj).length) out.push(`@@ settings ${app}`, json(obj), "");
    for (const [app, css] of Object.entries(theme.css || {})) if (css) out.push(`@@ css ${app}`, css.replace(/\s+$/, ""), "");
    for (const x of theme.extra || []) out.push(`@@ ${x.type}${x.name ? " " + x.name : ""}${x.encoding ? " " + x.encoding : ""}`, x.text || "", "");
    for (const a of theme.assets || []) {
      if (!NAME_RE.test(a.name)) throw new WmtError(`Недопустимое имя ресурса «${a.name}»`);
      out.push(`@@ asset ${a.name} base64`, b64encode(a.bytes), "");
    }
    return out.join("\n");
  }

  const api = { VERSION, MAX_FILE, parse, serialize, open, pack, isZip, unzip, zip, BG_EXT, mimeOf, stripJsonc, WmtError, ID_RE, NAME_RE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WMT = api;
})(typeof window !== "undefined" ? window : globalThis);
