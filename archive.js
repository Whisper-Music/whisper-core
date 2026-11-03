// core/archive.js — Whisper Archive в любом приложении Whisper: свои треки из архива вместо версий сервиса.
// Общий модуль ядра (core/whisper-core.js, docs/CORE.md «Общие модули»): работает только через window.Whisper
// и Rust-папка rust/whisper/ ядра (команды wa_*, протокол wa://). Подключается после привязки приложения (yandex.js).
//
// Как работает: при включённой настройке модуль собирает список треков из альбомов владельца токена (/api/albums/mine).
// Когда приложение включает трек, ядро спрашивает источники звука (Whisper.sources) — архив ищет трек
// с тем же названием и тем же исполнителем. Нашёлся — играет файл из архива; нет или архив недоступен — версия сервиса.
// Следующий трек очереди, если он есть в архиве, подгружается заранее.
// «Сохранить в архив» в меню трека — если провайдер умеет (provider.archiveSave: файл трека берёт сам сервис).
// Токен wa_… хранится только в системном хранилище: JavaScript передаёт его в Rust один раз и больше не видит.
(() => {
  const W = window.Whisper;
  if (!W) { console.error("archive.js: нет ядра Whisper — подключи core/whisper-core.js раньше"); return; }
  const kit = W.ui.kit;
  const { invoke } = window.__TAURI__.core;
  const CFG_KEY = "wa_cfg", IDX_KEY = "wa_index_mine";
  try { localStorage.removeItem("wa_index"); } catch {}      // старый индекс включал и чужие публичные альбомы
  const IDX_TTL = 20 * 60 * 1000;          // список треков архива обновляется не чаще раза в 20 минут
  const RETRY_AFTER = 2 * 60 * 1000;       // после ошибки сервер не дёргаем 2 минуты
  const FIRST_WAIT = 6000;                 // самый первый список ждём не дольше 6 с, дальше играет Яндекс
  const MAX_ALBUMS = 500;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const AUDIO_EXT = /\.(mp3|flac|wav|ogg|oga|opus|m4a|aac|wma|aiff?|alac)$/i;

  const st = { on: false, hasToken: false, nick: "", map: new Map(), at: 0, info: null, sync: null, failAt: 0, blobs: new Map() };
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY) || "{}");
    st.on = !!c.on;
    st.nick = typeof c.nick === "string" ? c.nick.slice(0, 64) : "";
  } catch {}

  const msg = (e) => String(e?.message || e || "неизвестная ошибка");
  // команда не зарегистрирована в lib.rs или не разрешена в build.rs / capabilities/default.json
  const rustMissing = (e) => (/not found|unknown command|not allowed/i.test(msg(e))
    ? `Приложение не пускает команды Whisper Archive (${msg(e)}). Нужны src/core/rust/whisper (подмодуль ядра) и whisper_host.rs, регистрация в lib.rs и разрешения в build.rs и capabilities/default.json.` : "");
  const pl = (n, a, b, c) => { const m = n % 100, d = n % 10; return m > 10 && m < 20 ? c : d === 1 ? a : d >= 2 && d <= 4 ? b : c; };

  // ---------- сравнение названий и исполнителей ----------
  const lower = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/ё/g, "е");
  const squash = (s) => s.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  // «(feat. X)», «[ft. X]», «… feat. X» в названии не мешают совпадению
  const FEAT = /[(\[]\s*(?:feat|ft|featuring|при участии|при уч)\.?\s[^)\]]*[)\]]|\s(?:feat|ft|featuring)\.?\s.*$/giu;
  const normTitle = (s) => squash(lower(s).replace(FEAT, " "));
  const SPLIT = /\s*(?:[,;&/+]|\s(?:feat|ft|featuring|vs|x|х|и|and)\.?\s)\s*/iu;
  function splitArtists(v) {
    const whole = squash(lower(v));
    const out = new Set(whole ? [whole] : []);
    for (const p of lower(v).split(SPLIT)) { const n = squash(p); if (n) out.add(n); }
    return [...out];
  }

  // ---------- разбор ответов API (поля ищем без учёта регистра и под разными именами) ----------
  function pick(o, ...names) {
    if (!o || typeof o !== "object") return undefined;
    for (const n of names) {
      if (o[n] != null) return o[n];
      const k = Object.keys(o).find((x) => x.toLowerCase() === n.toLowerCase());
      if (k && o[k] != null) return o[k];
    }
    return undefined;
  }
  function nameOf(v) {
    if (v == null) return "";
    if (typeof v === "string") return v.trim();
    if (Array.isArray(v)) return v.map(nameOf).filter(Boolean).join(", ");
    if (typeof v === "object") return String(pick(v, "name", "nickname", "displayName", "userName", "title") ?? "").trim();
    return String(v);
  }
  function listOf(x) {
    if (Array.isArray(x)) return x;
    for (const k of ["albums", "items", "data", "results", "value"]) { const v = pick(x, k); if (Array.isArray(v)) return v; }
    return [];
  }
  function tracksOf(a) {
    const v = pick(a, "tracks");
    return Array.isArray(v) ? v : null;
  }
  function albumArtistOf(a) {
    const direct = nameOf(pick(a, "artist", "artists", "author", "performer", "artistName"));
    if (direct) return direct;
    const owner = nameOf(pick(a, "owner", "user", "uploader", "creator"))
      || nameOf(pick(a, "ownerNickname", "nickname", "ownerName", "userName", "authorNickname"));
    if (owner) return owner;
    const d = String(pick(a, "title", "name") ?? "").split(/\s+[-–—]\s+/);     // «Исполнитель - Альбом»
    return d.length >= 2 ? d[0] : "";
  }
  function trackEntry(tr, albumArtist, own) {
    const id = String(pick(tr, "id", "trackId", "uuid") ?? "");
    if (!UUID.test(id)) return null;
    let title = nameOf(pick(tr, "title", "name", "trackTitle"));
    if (!title) {                                                            // нет названия — берём имя файла
      title = nameOf(pick(tr, "fileName", "originalFileName", "filename", "file"))
        .replace(/^.*[\\/]/, "").replace(AUDIO_EXT, "").replace(/^\s*\d{1,3}\s*[.)_-]\s*/, "");
    }
    title = title.replace(AUDIO_EXT, "");
    if (!title) return null;
    let artist = nameOf(pick(tr, "artist", "artists", "author", "authors", "performer", "performers", "artistName", "band"));
    const titles = new Set([normTitle(title)]);
    const dash = title.split(/\s+[-–—]\s+/);
    if (dash.length >= 2) {                                                  // «Исполнитель - Название»
      titles.add(normTitle(dash.slice(1).join(" - ")));
      if (!artist) artist = dash[0];
    }
    if (!artist) artist = albumArtist;
    titles.delete("");
    return { i: id, t: [...titles], a: artist ? splitArtists(artist) : [], o: own ? 1 : 0 };
  }

  // ---------- список треков архива ----------
  // У каждого запроса к архиву своя команда Rust (rust/whisper/): путь к API интерфейс не задаёт.
  async function waGet(cmd, args) {
    const r = await invoke(cmd, args);
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error(`сервер не принял токен (HTTP ${r.status})`), { status: r.status });
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error("HTTP " + r.status), { status: r.status });
    try { return r.body ? JSON.parse(r.body) : null; } catch { throw new Error("сервер вернул не JSON"); }
  }
  async function pool(items, n, fn) {
    let k = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (k < items.length) { const it = items[k++]; try { await fn(it); } catch {} }
    }));
  }
  async function buildIndex() {
    // только альбомы владельца токена: публичные альбомы других пользователей в поиск не попадают
    const mine = await waGet("wa_albums_mine");
    const albums = new Map();                                                 // id -> { a, own }
    for (const a of listOf(mine)) {
      const id = String(pick(a, "id") ?? "");
      if (UUID.test(id) && !albums.has(id)) albums.set(id, { a, own: true });
    }
    const list = [...albums.entries()].slice(0, MAX_ALBUMS);
    const entries = [];
    let failed = 0;
    await pool(list, 4, async ([id, { a, own }]) => {
      let full = a, tr = tracksOf(a);
      if (!tr) {
        try {
          const r = await waGet("wa_album", { id });
          const inner = pick(r, "album");
          const src = inner && typeof inner === "object" && !Array.isArray(inner) ? inner : r;
          full = { ...a, ...(src && typeof src === "object" ? src : {}) };
          tr = tracksOf(full) || tracksOf(r) || [];
        } catch { failed++; return; }
      }
      const art = albumArtistOf(full);
      for (const t of tr) { const e = trackEntry(t, art, own); if (e) entries.push(e); }
    });
    return { at: Date.now(), albums: list.length, failed, list: entries };
  }
  function applyIndex(idx) {
    st.map = new Map();
    for (const e of idx.list) for (const t of e.t) { const arr = st.map.get(t); arr ? arr.push(e) : st.map.set(t, [e]); }
    st.at = idx.at;
    st.info = { tracks: idx.list.length, noArtist: idx.list.filter((e) => !e.a.length).length, albums: idx.albums, failed: idx.failed };
  }
  function loadCachedIndex() {
    try {
      const idx = JSON.parse(localStorage.getItem(IDX_KEY) || "null");
      if (!idx || !Array.isArray(idx.list) || !Number.isFinite(idx.at)) return;
      const strs = (x) => Array.isArray(x) && x.every((s) => typeof s === "string");
      idx.list = idx.list.filter((e) => e && UUID.test(e.i) && strs(e.t) && strs(e.a));
      applyIndex(idx);
    } catch {}
  }
  function clearIndex() {
    st.map = new Map(); st.at = 0; st.info = null; st.blobs.clear();
    try { localStorage.removeItem(IDX_KEY); } catch {}
  }
  function sync() {
    if (st.sync) return st.sync;
    st.sync = (async () => {
      try {
        const idx = await buildIndex();
        applyIndex(idx); st.failAt = 0;
        try { localStorage.setItem(IDX_KEY, JSON.stringify(idx)); } catch {}
        return idx;
      } catch (e) { st.failAt = Date.now(); throw e; }
      finally { st.sync = null; }
    })();
    return st.sync;
  }
  async function ensureIndex() {
    if (st.at && Date.now() - st.at < IDX_TTL) return;
    if (st.failAt && Date.now() - st.failAt < RETRY_AFTER) return;
    const p = sync().catch(() => {});
    if (!st.at) await Promise.race([p, new Promise((r) => setTimeout(r, FIRST_WAIT))]);     // устаревший список обновляем в фоне
  }
  function lookup(t) {
    if (!t?.title || !st.map.size) return null;
    const key = normTitle(t.version ? `${t.title} ${t.version}` : t.title);
    const ya = new Set((t.artists || []).flatMap((a) => splitArtists(a?.name)));
    if (!key || !ya.size) return null;
    const hits = (st.map.get(key) || []).filter((e) => e.a.some((x) => ya.has(x)));
    return hits.find((e) => e.o) || hits[0] || null;
  }

  // ---------- файлы ----------
  function sniffAudio(b) {
    const at = (i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
    if (at(0, "fLaC")) return "audio/flac";
    if (at(0, "OggS")) return "audio/ogg";
    if (at(0, "RIFF") && at(8, "WAVE")) return "audio/wav";
    if (at(4, "ftyp")) return "audio/mp4";
    if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return "audio/aac";
    if (at(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
    return "";
  }
  function getBlob(id) {                     // небольшой кэш: текущий и следующий трек, чтобы не качать дважды
    if (st.blobs.has(id)) { const p = st.blobs.get(id); st.blobs.delete(id); st.blobs.set(id, p); return p; }
    const p = invoke("wa_stream", { id }).then((buf) => { const b = new Uint8Array(buf); return new Blob([b], { type: sniffAudio(b) }); });
    p.catch(() => { if (st.blobs.get(id) === p) st.blobs.delete(id); });
    st.blobs.set(id, p);
    while (st.blobs.size > 3) st.blobs.delete(st.blobs.keys().next().value);
    return p;
  }
  // Начало следующего трека из архива берётся заранее (Rust держит ~0,5 МБ в памяти) — он стартует без ожидания сети.
  function prefetch(t) {
    if (!t || !st.on || !st.hasToken) return;
    const h = lookup(t);
    if (h) invoke("wa_prefetch", { id: h.i }).catch(() => {});
  }
  // Адрес потока по правилам Tauri: http://wa.localhost/… в Windows, wa://localhost/… в Linux и macOS.
  const STREAM_BASE = (() => {
    try { return window.__TAURI__.core.convertFileSrc("", "wa").replace(/\/?$/, "/"); } catch { return "wa://localhost/"; }
  })();

  // ---------- источник звука для ядра ----------
  // Перед загрузкой трека: { id, url } — трек есть в архиве, url — поток кусками (wa://, ключ подставляет Rust);
  // null — играет версия сервиса. Ничего не скачивает целиком и не бросает ошибок.
  // blob — запасной путь, если поток не заиграл (например, WebKitGTK в Linux не всегда умеет медиа из своих протоколов): файл целиком.
  W.sources.register({
    id: "archive", name: "Whisper Archive", priority: 10,
    async resolve(t, next) {
      badge(false);
      if (!st.hasToken || !t) return null;
      // waShared — трек из архива ведущего «Слушать вместе» (core/together.js): играет и у гостя без своей копии
      // и даже с выключенной настройкой (комнаты и так работают только через архив). Своя копия — главнее.
      // Метка лежит в сырых данных трека: приложение кладёт в очередь t.raw, а сущность из него (W.to) собирается заново
      // по toTrack провайдера — лишних полей вроде waShared там уже нет. Поэтому смотрим и t.raw.
      const sh = [t.waShared, t.raw?.waShared].find((x) => UUID.test(String(x || "")));
      const shared = sh ? String(sh) : null;
      if (!st.on && !shared) return null;
      try {
        let id = null;
        if (st.on) {
          await ensureIndex();
          id = lookup(t)?.i || null;
          prefetch(next);
        }
        id = id || shared;
        return id ? { id, url: STREAM_BASE + "track/" + id, blob: () => getBlob(id) } : null;
      } catch { return shared ? { id: shared, url: STREAM_BASE + "track/" + shared, blob: () => getBlob(shared) } : null; }
    },
  });
  // Метка — маленькая печать со значком архива на углу обложки в плеере: место у названия и автора не занимает.
  // Обложку оборачиваем один раз; сам элемент #cover (с его обработчиком клика) просто переезжает в обёртку.
  let badgeEl = null, wrapEl = null;
  function badge(on) {
    if (!badgeEl) {
      const cov = W.ui.all("player.cover")[0];          // обложка играющего трека в плеере
      if (!cov) return;
      wrapEl = document.createElement("span");
      wrapEl.className = "wacov";
      cov.replaceWith(wrapEl);
      wrapEl.append(cov);
      badgeEl = document.createElement("span");
      badgeEl.className = "waseal";
      badgeEl.title = "Играет версия из Whisper Archive";
      badgeEl.setAttribute("role", "img");
      badgeEl.setAttribute("aria-label", "Версия из Whisper Archive");
      badgeEl.innerHTML = "<b>WA</b>";
      wrapEl.append(badgeEl);
    }
    badgeEl.hidden = !on;
    wrapEl.classList.toggle("on", !!on);
    document.body.classList.toggle("wa-playing", !!on);
  }
  // откуда звук — сообщает приложение (report({ source })): «archive» — печать на обложке
  W.on("source", ({ source }) => badge(source === "archive"));

  // ---------- ответы сервера ----------
  // Сервер отвечает по-разному: строкой, { message }, ProblemDetails с errors, массивом строк или HTML-страницей прокси.
  function errText(r) {
    if (r.status === 429) return "Слишком много попыток — подожди несколько минут и попробуй снова.";
    if (r.status === 401) return "Вход в Whisper Archive больше не действует — войди заново.";
    let m = "";
    const body = String(r.body || "").trim();
    try {
      const v = JSON.parse(body);
      if (typeof v === "string") m = v;
      else if (Array.isArray(v)) m = v.filter((x) => typeof x === "string").join(" ");
      else if (v && typeof v === "object") {
        if (typeof v.message === "string") m = v.message;
        else if (v.errors && typeof v.errors === "object") m = Object.values(v.errors).flat().filter((x) => typeof x === "string").join(" ");
        else if (typeof v.title === "string") m = v.title;
      }
    } catch { if (!body.startsWith("<")) m = body; }
    m = m.replace(/\s+/g, " ").trim().slice(0, 300);
    if (r.status === 403) return m || "Нет доступа: ключ только на чтение или альбом принадлежит другому аккаунту.";
    if (r.status === 413) return "Файл слишком большой для архива.";
    return m || `сервер ответил HTTP ${r.status}`;
  }

  // ---------- вход по почте ----------
  // Почта -> код из письма -> ключ приложения. Ключ кладёт в хранилище Rust; сюда возвращается только никнейм.
  const EMAIL_KEY = "wa_email";
  const lastEmail = () => { try { return localStorage.getItem(EMAIL_KEY) || ""; } catch { return ""; } };
  const keepEmail = (e) => { try { localStorage.setItem(EMAIL_KEY, e); } catch {} };
  const closeMenu = () => kit.closeMenu();
  const toast = (...a) => kit.toast(...a);

  function onLoggedIn(nickname) {
    st.hasToken = true; st.nick = nickname || ""; saveCfg();
    clearIndex(); render();
    note(st.nick ? `Вход выполнен: ${st.nick}.` : "Вход выполнен.");
    sync().then(() => note(summary())).catch(() => {});
  }

  let loginP = null;
  function waLogin(reason = "") {
    if (loginP) return loginP;
    closeMenu();
    loginP = new Promise((resolve) => {
      const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
      const wrap = el("div", "login modal");
      const box = el("form", "panel login-box modalbox wamodal"); box.noValidate = true;
      const lead = el("p");
      const email = el("input", "field"); Object.assign(email, { type: "email", placeholder: "Почта", autocomplete: "email", maxLength: 254, value: lastEmail() });
      const nick = el("input", "field"); Object.assign(nick, { type: "text", placeholder: "Никнейм, от 3 до 32 символов", maxLength: 32, hidden: true });
      const code = el("input", "field wacode"); Object.assign(code, { type: "text", inputMode: "numeric", autocomplete: "one-time-code", placeholder: "••••••", maxLength: 6, hidden: true });
      const links = el("div", "walinks"); links.hidden = true;
      const resend = el("button", "walink", "Отправить код ещё раз"); resend.type = "button";
      const change = el("button", "walink", "Другая почта"); change.type = "button";
      links.append(resend, change);
      const err = el("p", "status");
      const row = el("div", "row");
      const no = el("button", "nav", "Отмена"); no.type = "button";
      const yes = el("button", "nav active"); yes.type = "submit";
      row.append(no, yes);
      box.append(el("h2", "", "Вход в Whisper Archive"), lead, email, nick, code, links, err, row);
      wrap.append(box); document.body.append(wrap);

      let step = "email", busy = false, sentTo = "";
      const LEAD = reason ? reason + " " : "";
      const label = () => (step === "email" ? "Получить код" : "Войти");
      const setBusy = (b, text) => { busy = b; yes.disabled = no.disabled = resend.disabled = change.disabled = b; yes.textContent = b ? text : label(); };
      const done = (v) => { document.removeEventListener("keydown", onKey, true); wrap.remove(); resolve(v); };
      const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); if (!busy) done(false); } };
      document.addEventListener("keydown", onKey, true);
      no.onclick = () => done(false);
      wrap.onpointerdown = (e) => { if (e.target === wrap && !busy) done(false); };

      const toEmail = () => {
        step = "email"; err.textContent = "";
        email.hidden = false; code.hidden = true; links.hidden = true; code.value = "";
        lead.textContent = LEAD + "На почту придёт код для входа. Если аккаунта нет, он будет создан.";
        yes.textContent = label(); email.focus();
      };
      const toCode = () => {
        step = "code"; err.textContent = "";
        email.hidden = true; nick.hidden = true; code.hidden = false; links.hidden = false;
        lead.textContent = `Код отправлен на ${sentTo}. Он действует 10 минут.`;
        yes.textContent = label(); code.focus();
      };

      async function sendCode() {
        const e = email.value.trim(), n = nick.hidden ? "" : nick.value.trim();
        if (!/^[^\s@]+@[^\s@]+$/.test(e)) { err.textContent = "Проверь адрес почты."; email.hidden = false; email.focus(); return; }
        if (!nick.hidden && n.length < 3) { err.textContent = "Никнейм — минимум 3 символа."; nick.focus(); return; }
        err.textContent = ""; setBusy(true, "Отправка…");
        try {
          const r = await invoke("wa_auth_request_code", { email: e, nickname: n || null });
          if (r.status >= 200 && r.status < 300) { sentTo = e; keepEmail(e); toCode(); return; }
          const t = errText(r);
          if (r.status === 400 && nick.hidden && /никнейм/i.test(t)) {      // такой почты нет — регистрация
            nick.hidden = false;
            lead.textContent = "Аккаунта с этой почтой нет. Укажи никнейм — аккаунт будет создан.";
            nick.focus(); return;
          }
          err.textContent = t;
        } catch (x) { err.textContent = rustMissing(x) || msg(x); }
        finally { if (wrap.isConnected) setBusy(false); }
      }
      async function verify() {
        const c = code.value.replace(/\D/g, "");
        if (c.length !== 6) { err.textContent = "Код — 6 цифр из письма."; code.focus(); return; }
        err.textContent = ""; setBusy(true, "Проверка…");
        try {
          const r = await invoke("wa_auth_issue", { email: sentTo, code: c });
          if (r?.ok) kit.secretSaved();
          if (r.ok) { onLoggedIn(r.nickname); done(true); return; }
          err.textContent = errText(r);
          if (/истёк|не найден|попыток/i.test(err.textContent)) err.textContent += " Нажми «Отправить код ещё раз».";
          code.select();
        } catch (x) { err.textContent = rustMissing(x) || msg(x); }
        finally { if (wrap.isConnected) setBusy(false); }
      }

      resend.onclick = async () => { if (busy) return; await sendCode(); if (step === "code" && !err.textContent) err.textContent = "Новый код отправлен."; };
      change.onclick = () => { if (!busy) toEmail(); };
      code.oninput = () => {
        code.value = code.value.replace(/\D/g, "").slice(0, 6);
        if (code.value.length === 6 && !busy) verify();            // код вставили целиком — входим сразу
      };
      box.onsubmit = (e) => { e.preventDefault(); if (!busy) (step === "email" ? sendCode() : verify()); };
      toEmail();
      if (email.value) email.select();
    }).finally(() => { loginP = null; });
    return loginP;
  }
  window.waLogin = waLogin;              // «Слушать вместе» (together.js) просит войти по приглашению

  // ---------- «Сохранить в архив» в меню «⋯» ----------
  const saving = new Set();                       // id треков сервиса, которые сейчас загружаются
  const MAX_TITLE = 75;                           // лимит сервера на название альбома
  const clampTitle = (s) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > MAX_TITLE ? s.slice(0, MAX_TITLE - 1).trimEnd() + "…" : s; };

  // Название трека в архиве = имя файла. Поля «исполнитель» на сервере нет, поэтому пишем «Исполнитель - Название»:
  // так трек потом находится при подмене (см. trackEntry).
  function trackFileName(t) {
    const artists = (t.artists || []).map((a) => a?.name).filter(Boolean).join(", ");
    const title = t.version ? `${t.title} (${t.version})` : String(t.title || "");
    return artists ? `${artists} - ${title}` : title || "Трек";
  }

  // У трека нет обложки, а новому альбому она обязательна — рисуем простую в цветах темы.
  async function fallbackCover(t) {
    const S = 600, c = document.createElement("canvas"); c.width = c.height = S;
    const g = c.getContext("2d"), cs = getComputedStyle(document.documentElement);
    const a1 = cs.getPropertyValue("--accent").trim() || "#a66bff", a2 = cs.getPropertyValue("--accent2").trim() || "#e060ff";
    const gr = g.createLinearGradient(0, 0, S, S); gr.addColorStop(0, a1); gr.addColorStop(1, a2);
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(0, S * 0.66, S, S * 0.34);
    g.fillStyle = "#fff"; g.textBaseline = "middle"; g.font = "600 40px system-ui, 'Segoe UI', sans-serif";
    let text = String(t.title || "Трек");
    while (text.length > 1 && g.measureText(text).width > S - 80) text = text.slice(0, -2).trimEnd() + "…";
    g.fillText(text, 40, S * 0.83);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    if (!blob) throw new Error("не удалось нарисовать обложку");
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }

  async function saveTrack(t, target) {
    const id = String(t.id);
    if (saving.has(id)) return;
    saving.add(id);
    const where = target.id ? `в альбом «${target.title}»` : `в новый альбом «${target.title}»`;
    toast(`«${t.title}» сохраняется ${where}…`, 0);
    try {
      // файл трека берёт сам сервис (provider.archiveSave → Rust скачивает его по номеру, адрес файла интерфейс не передаёт)
      const args = { fileName: trackFileName(t), albumId: target.id || null, albumTitle: null, coverUrl: null, coverBytes: null };
      if (!target.id) {
        args.albumTitle = target.title;
        const cu = W.cover(t, 800);
        if (cu) args.coverUrl = cu; else args.coverBytes = await fallbackCover(t);
      }
      const r = await W.provider().archiveSave(t, args);
      if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(errText(r)), { status: r.status });
      toast(`«${t.title}» сохранён ${where}`, 4500, { kind: "ok" });
      st.at = 0; st.failAt = 0;
      sync().then(() => note(summary())).catch(() => {});      // чтобы трек сразу находился в архиве
    } catch (e) {
      if (e?.status === 401) {
        toast("Вход в Whisper Archive больше не действует", 8000, { kind: "err", action: { label: "Войти", fn: () => waLogin().then((ok) => ok && saveTrack(t, target)) } });
      } else toast("Не удалось сохранить в архив: " + (rustMissing(e) || msg(e)), 8000, { kind: "err" });
    } finally { saving.delete(id); }
  }

  // m — меню трека приложения (kit.menu): пункты, подписи, вложенный список, «назад»
  async function archiveMenu(t, m) {
    if (saving.has(t.id)) return;
    if (!st.hasToken) {                                    // не вошли — сначала окно входа, потом снова это меню
      const anchor = m.anchor();
      m.close();
      const ok = await waLogin("Для сохранения в архив нужен вход.");
      if (ok && anchor?.isConnected) m.reopen(anchor, () => archiveMenu(t, m));
      return;
    }
    const seq = m.reset();
    m.head("Сохранить в архив");
    if (lookup(t)) m.note("Трек уже есть в архиве — будет сохранена копия.");
    const newTitle = clampTitle(t.album?.title || t.title) || "Без названия";
    m.item(kit.icon("plus"), `Новый альбом «${newTitle}»`, () => saveTrack(t, { title: newTitle }));
    const box = m.scroll();
    const wait = m.note("Загрузка альбомов…", box);
    m.place();
    let albums;
    try { albums = listOf(await waGet("wa_albums_mine")); }
    catch (e) {
      if (!m.alive(seq)) return;
      if (e?.status === 401 || e?.status === 403) {
        wait.textContent = "Вход в Whisper Archive больше не действует.";
        m.item("", "Войти заново", () => waLogin().then((ok) => ok && toast("Вход выполнен — открой меню ещё раз", 3500, { kind: "ok" })), { to: box });
      } else wait.textContent = "Не удалось загрузить альбомы: " + msg(e);
      m.place(); return;
    }
    if (!m.alive(seq)) return;
    wait.remove();
    if (!albums.length) m.note("Альбомов пока нет.", box);
    for (const a of albums) {
      const aid = String(pick(a, "id") ?? "");
      if (!UUID.test(aid)) continue;
      const title = nameOf(pick(a, "title")) || "Без названия";
      const n = Number(pick(a, "trackCount")) || 0, full = n >= 50;
      const b = m.item("", title, () => saveTrack(t, { id: aid, title }), { to: box });
      b.classList.add("mpl");
      const c = document.createElement("small");
      c.textContent = full ? "заполнен" : `${n} ${pl(n, "трек", "трека", "треков")}`;
      b.append(c);
      if (full) { b.disabled = true; b.title = "В альбоме уже 50 треков — больше архив не принимает"; }
      else if (String(pick(a, "visibility") || "").toLowerCase() === "public") b.title = "Публичный альбом — трек увидят все";
    }
    m.place();
  }

  const ARCH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M3 3.5h18V8H3zM4.5 9h15v11.5h-15zM9.5 11.6v1.7h5v-1.7z"/></svg>';
  // пункт в меню «⋯» трека — только если сервис умеет отдать файл трека в архив
  W.ui.trackMenu.add({
    id: "archive",
    build(t, m) {
      if (!t?.id || typeof W.provider()?.archiveSave !== "function") return;
      const busy = saving.has(t.id);
      const b = m.item(ARCH_ICON, busy ? "Сохраняется в архив…" : "Сохранить в архив", () => archiveMenu(t, m), { keep: true, arrow: !busy && st.hasToken });
      if (busy) b.disabled = true;
    },
  });

  // ---------- настройки ----------
  const $w = (id) => document.getElementById(id);
  function note(text) { const n = $w("waNote"); if (n) n.textContent = text || ""; }
  function summary() {
    const i = st.info;
    if (!i) return "";
    if (!i.tracks) return "В архиве пока нет треков.";
    let s = `В архиве ${i.tracks} ${pl(i.tracks, "трек", "трека", "треков")}, ${i.albums} ${pl(i.albums, "альбом", "альбома", "альбомов")}.`;
    if (i.noArtist) s += ` Без исполнителя: ${i.noArtist} — не подменяются.`;
    if (i.failed) s += ` Не загрузилось альбомов: ${i.failed}.`;
    return s;
  }
  function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify({ on: st.on, nick: st.nick })); } catch {} }
  function render() {
    if (!$w("waCard")) return;
    $w("waOn").checked = st.on;
    $w("waBox").hidden = !st.on;
    $w("waToken").placeholder = st.hasToken ? "Ключ сохранён · можно заменить" : "API-ключ (необязательно)";
    $w("waAcc").textContent = st.hasToken ? (st.nick ? `Аккаунт: ${st.nick}` : "Аккаунт подключён") : "Не выполнен вход";
    $w("waLoginBtn").textContent = st.hasToken ? "Сменить аккаунт" : "Войти по почте";
    $w("waSync").hidden = $w("waForget").hidden = !st.hasToken;
  }
  async function refreshNick() {                  // для ключа, вставленного вручную, никнейм узнаём у сервера
    try {
      const me = await waGet("wa_me");
      const n = nameOf(pick(me, "nickname"));
      if (n && n !== st.nick) { st.nick = n.slice(0, 64); saveCfg(); render(); }
    } catch (e) { if (e?.status === 401) { $w("waAcc") && ($w("waAcc").textContent = "Вход больше не действует — войди заново"); } }
  }
  async function doSync() {
    const b = $w("waSync");
    b.disabled = true; note("Обновление списка треков…");
    try { await sync(); note(summary()); }
    catch (e) { note("Не удалось получить треки архива: " + msg(e)); }
    finally { b.disabled = false; }
  }
  async function saveToken() {
    const inp = $w("waToken"), btn = $w("waSave"), v = inp.value.trim();
    if (!/^wa_\S+$/.test(v)) { note("Ключ должен начинаться с wa_."); return; }
    btn.disabled = true; note("Проверка ключа…");
    try {
      await invoke("wa_token_set", { token: v });
      kit.secretSaved();
      inp.value = ""; st.hasToken = true; st.nick = ""; saveCfg();
      clearIndex(); render(); refreshNick();
      await doSync();
    } catch (e) { note(rustMissing(e) || "Ключ не сохранён: " + msg(e)); }
    finally { btn.disabled = false; }
  }
  function mountSettings() {
    if ($w("waCard") || !kit.settingsCard) return;
    const card = document.createElement("div");
    card.id = "waCard";
    card.innerHTML = `
      <h3>Whisper Archive</h3>
      <div class="waacc">
        <span class="wainfo" tabindex="0" title="Аккаунт Whisper Archive: сохранение треков в архив и воспроизведение из него">ⓘ</span>
        <span id="waAcc" class="waaccname"></span>
        <button class="nav" id="waLoginBtn">Войти по почте</button>
        <button class="nav" id="waForget" hidden>Выйти</button>
      </div>
      <label class="switch" title="Трек из твоих альбомов с тем же названием и исполнителем играет вместо версии Яндекса. Действует со следующего трека"><input type="checkbox" id="waOn" /><i></i><span>Играть треки из архива</span></label>
      <div id="waBox" class="wabox" hidden>
        <div class="warow">
          <input id="waToken" type="password" placeholder="API-ключ (необязательно)" title="Ключ со страницы /developers на origin.whisper-archive.ru — вместо входа по почте" autocomplete="off" spellcheck="false" />
          <button class="nav" id="waSave">Сохранить</button>
        </div>
        <div class="row"><button class="nav" id="waSync" hidden>Обновить список треков</button></div>
      </div>
      <p id="waNote" class="status"></p>`;
    // куда встать, решает приложение: у Whisper Yandex — первой во вкладке «Интеграции»
    if (kit.settingsCard(card, { section: "integrations", first: true }) === false || !card.isConnected) return;
    $w("waOn").onchange = (e) => {
      st.on = e.target.checked; saveCfg(); render();
      if (!st.on) { badge(false); return; }
      if (!st.hasToken) note("Войди по почте или вставь API-ключ.");
      else if (!st.at) doSync();
      else note(summary());
    };
    $w("waLoginBtn").onclick = () => waLogin();
    $w("waSave").onclick = saveToken;
    $w("waToken").addEventListener("keydown", (e) => { if (e.key === "Enter") saveToken(); });
    $w("waSync").onclick = doSync;
    $w("waForget").onclick = async () => {
      try { await invoke("wa_token_clear"); }
      catch (e) { note("Не удалось выйти: " + msg(e)); return; }
      try { localStorage.removeItem(EMAIL_KEY); } catch {}       // и почту, которую подставляли в окно входа
      st.hasToken = false; st.nick = ""; saveCfg(); clearIndex(); badge(false); render(); note("Выход выполнен.");
    };
  }

  W.modules.archive = {
    login: waLogin,
    enabled: () => st.on && st.hasToken,
    connected: () => st.hasToken,
    lookup: (t) => { const h = lookup(W.to("track", t)); return h ? { id: h.i } : null; },
    sync: () => sync(),
  };

  // ---------- старт ----------
  (async () => {
    mountSettings();
    try { st.hasToken = !!(await invoke("wa_token_exists")); }
    catch (e) { st.hasToken = false; note(rustMissing(e) || "Не удалось прочитать ключ: " + msg(e)); }
    if (st.hasToken) { loadCachedIndex(); refreshNick(); }
    render();
    if (st.on && st.hasToken) {
      note(summary());
      if (!st.at || Date.now() - st.at > IDX_TTL) sync().then(() => note(summary())).catch(() => {});
    }
  })();
})();
