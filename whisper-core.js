"use strict";
// Whisper Core — общее ядро приложений Whisper (Whisper Yandex, Whisper VK, …).
// Подробно — docs/CORE.md. Файл самостоятельный: без зависимостей, без сборки, ничего не знает ни о Яндексе,
// ни о разметке конкретного приложения. Его можно копировать между приложениями как есть.
//
// Что здесь есть:
// * шина событий            Whisper.on("track", fn) / Whisper.emit(…)
// * общие сущности          Track, Artist, Album, Playlist, User — одинаковые в любом приложении
// * провайдер и возможности  музыкальный сервис объявляет, что умеет (Whisper.caps("lyrics"))
// * плеер и очередь          один API для модулей: Whisper.player.next(), Whisper.queue.list()
// * роли интерфейса          [data-w="search"] в теме → селекторы этого приложения (общие темы)
//
// Приложение подключает ядро ПЕРВЫМ (до своего кода), затем объявляет провайдера, роли и привязывает плеер.
(() => {
  if (window.Whisper) return;                  // второе подключение (мини-плеер, отладка) — ядро уже есть

  // ---------- шина событий ----------
  // Ошибка в одном слушателе не должна ломать плеер и остальных: каждый вызывается отдельно.
  const subs = new Map();          // событие -> Set(fn)
  // { replay: true } — сразу получить текущее состояние (трек, пуск/пауза, громкость, режимы, скорость):
  // модулю, который подключился позже, не нужно ждать следующего изменения
  function on(ev, fn, { replay = false } = {}) {
    if (typeof fn !== "function") return () => {};
    (subs.get(ev) || subs.set(ev, new Set()).get(ev)).add(fn);
    if (replay && REPLAY[ev]) { try { fn(REPLAY[ev]()); } catch (e) { console.error(`Whisper: слушатель «${ev}» упал:`, e); } }
    return () => subs.get(ev)?.delete(fn);
  }
  function once(ev, fn) { const off = on(ev, (p) => { off(); fn(p); }); return off; }
  function emit(ev, payload) {
    for (const key of ev === "player:sync" ? [ev] : [ev, "*"]) {         // служебное «посмотри ещё раз» — не в общий поток
      for (const fn of [...(subs.get(key) || [])]) {
        try { key === "*" ? fn(ev, payload) : fn(payload); }
        catch (e) { console.error(`Whisper: слушатель «${ev}» упал:`, e); }
      }
    }
  }

  // ---------- сущности ----------
  // Одинаковая форма данных во всех приложениях. raw — исходный объект сервиса: модули, которым нужно
  // что-то особенное, берут оттуда, но общие системы (очередь, Discord, OBS, статистика) работают только с полями.
  // cover — шаблон адреса обложки: «{size}» заменяется на размер (Whisper.cover(x, 200)). Нет «{size}» — адрес как есть.
  const str = (v, n = 500) => (v == null ? "" : String(v).slice(0, n));
  const num = (v) => (Number.isFinite(+v) && v !== null && v !== "" ? +v : 0);
  const ref = (a) => (a ? { id: str(a.id, 100), name: str(a.name ?? a.title, 300) } : null);
  const entity = {
    track: (o = {}) => ({
      kind: "track", provider: str(o.provider, 40), id: str(o.id, 100), title: str(o.title, 300), version: str(o.version, 200),
      artists: (o.artists || []).map(ref).filter(Boolean), album: o.album ? { id: str(o.album.id, 100), title: str(o.album.title, 300) } : null,
      cover: str(o.cover, 2000), durationMs: num(o.durationMs), explicit: !!o.explicit, available: o.available !== false, raw: o.raw ?? null,
    }),
    artist: (o = {}) => ({ kind: "artist", provider: str(o.provider, 40), id: str(o.id, 100), name: str(o.name, 300), cover: str(o.cover, 2000), description: str(o.description, 5000), raw: o.raw ?? null }),
    album: (o = {}) => ({
      kind: "album", provider: str(o.provider, 40), id: str(o.id, 100), title: str(o.title, 300), artists: (o.artists || []).map(ref).filter(Boolean),
      cover: str(o.cover, 2000), year: num(o.year) || null, trackCount: num(o.trackCount), tracks: Array.isArray(o.tracks) ? o.tracks : null, raw: o.raw ?? null,
    }),
    playlist: (o = {}) => ({
      kind: "playlist", provider: str(o.provider, 40), id: str(o.id, 100), title: str(o.title, 300), owner: ref(o.owner),
      cover: str(o.cover, 2000), trackCount: num(o.trackCount), editable: !!o.editable, tracks: Array.isArray(o.tracks) ? o.tracks : null, raw: o.raw ?? null,
    }),
    user: (o = {}) => ({ kind: "user", provider: str(o.provider, 40), id: str(o.id, 100), name: str(o.name, 300), avatar: str(o.avatar, 2000), raw: o.raw ?? null }),
  };
  const cover = (x, size = 200) => {
    if (typeof cur?.coverUrl === "function" && x && typeof x === "object") { try { return String(cur.coverUrl(x, size) || ""); } catch { return ""; } }
    const c = typeof x === "string" ? x : x?.cover || "";
    return c.includes("{size}") ? c.replaceAll("{size}", `${size}x${size}`) : c;
  };

  // ---------- возможности ----------
  // Сервисы разные: где-то есть «Моя волна», где-то — своя библиотека и «Слушайте друг друга».
  // Вместо того чтобы делать всех одинаковыми, провайдер объявляет, что умеет, а интерфейс и модули спрашивают.
  // Неизвестное или не объявленное — «не умеет» (false / пустой список).
  const CAPS = {
    playback: "local",            // "local" — звук играет приложение (нужен stream), "remote" — пульт чужого плеера
    queue: true,                  // своя очередь: «играть следующим», перестановка, история
    like: false,                  // лайк / снять лайк
    dislike: false,               // «Не нравится»
    library: false,               // своя коллекция: добавить трек к себе / убрать (VK «Моя музыка»)
    playlists: { read: false, create: false, edit: false, reorder: false, delete: false },
    radio: false,                 // бесконечный поток рекомендаций: «Моя волна», «VK Микс»
    radioSeeds: [],               // от чего можно запускать поток: user, track, artist, album, genre, mood, …
    lyrics: false,                // false | "plain" | "synced"
    search: [],                   // что ищется: track, artist, album, playlist, user
    download: false,              // скачать трек на диск
    quality: [],                  // выбираемое качество потока: low, high, lossless
    social: [],                   // listen-together, friends-listening («Слушайте друг друга»), …
  };
  const merge = (base, over) => {
    const out = {};
    for (const [k, v] of Object.entries(base)) {
      const o = over?.[k];
      if (v && typeof v === "object" && !Array.isArray(v)) out[k] = merge(v, o);
      else if (Array.isArray(v)) out[k] = Array.isArray(o) ? o.map(String) : [];
      else out[k] = o === undefined ? v : typeof v === "boolean" && typeof o !== "string" ? !!o : o;
    }
    return out;
  };

  // ---------- провайдеры ----------
  // Провайдер — мост к музыкальному сервису: данные (поиск, лайки, альбомы) и «дай поток для трека».
  // Контракт и список методов — docs/CORE.md. Всё, кроме id, name и caps, необязательно.
  const providers = new Map();
  let cur = null;
  function registerProvider(p) {
    if (!p || !/^[a-z][a-z0-9-]{0,39}$/.test(p.id || "")) throw new Error("Whisper: у провайдера нужен id вида [a-z][a-z0-9-]*");
    const prov = { ...p, caps: merge(CAPS, p.caps || {}) };
    providers.set(p.id, prov);
    if (!cur) cur = prov;
    emit("provider", { provider: prov });
    return prov;
  }
  function useProvider(id) {
    const p = providers.get(id);
    if (!p) throw new Error(`Whisper: провайдер «${id}» не зарегистрирован`);
    cur = p; emit("provider", { provider: p });
    return p;
  }
  // Whisper.caps("playlists.edit") / Whisper.caps("search").includes("album")
  function caps(path) {
    let v = cur?.caps || merge(CAPS, {});
    for (const k of String(path || "").split(".").filter(Boolean)) v = v?.[k];
    return v === undefined ? false : v;
  }
  // Сырые данные сервиса -> сущность. У провайдера свои toTrack/toAlbum…; нет — объект считается уже готовым.
  function to(kind, raw) {
    if (raw == null) return null;
    if (raw.kind === kind && "raw" in raw) return raw;       // уже сущность
    const fn = cur?.["to" + kind[0].toUpperCase() + kind.slice(1)];
    const e = entity[kind](fn ? fn(raw) : raw);
    if (!e.provider) e.provider = cur?.id || "";
    if (e.raw == null) e.raw = raw;
    return e;
  }

  // ---------- плеер ----------
  // Кто играет звук и как устроена очередь — дело приложения: оно один раз привязывает свои функции (bind),
  // а дальше сообщает ядру, что произошло (report). Модули пользуются только Whisper.player / Whisper.queue
  // и событиями — им не нужно знать глобальные переменные приложения.
  let host = {};
  const st = { track: null, playing: false, volume: 1, liked: false, disliked: false, rate: 1, modes: { available: false, shuffle: false, repeat: 0 } };
  const call = (name, ...a) => (typeof host[name] === "function" ? host[name](...a) : undefined);
  const player = {
    bind(h) { host = { ...host, ...(h || {}) }; emit("player:bound", {}); },
    state: () => ({
      ...st,
      position: num(call("position")),
      duration: num(call("duration")) || (st.track ? st.track.durationMs / 1000 : 0),
      context: call("context") || null,          // откуда играет: { type: "album" | "playlist" | "radio" | "likes" | …, id, title }
    }),
    // «Посмотри ещё раз, что играет» — на каждом отчёте приложения о треке, пуске/паузе, перемотке, скорости, режимах,
    // даже если само значение не поменялось: у модуля может быть своё мнение о состоянии (Discord, например, сам
    // проверяет, не завис ли плеер на загрузке). Такие модули сравнивают отправленное с новым сами.
    // fn(force): force = true, когда позиция сдвинулась скачком (перемотка, скорость) и время нужно отправить заново.
    // Для модулей, которые отправляют «что играет» наружу: мини-плеер, OBS, Discord, «Слушать вместе».
    watch(fn) { return on("player:sync", ({ force }) => fn(force)); },
    play: () => call("play"),
    pause: () => call("pause"),
    toggle: () => call("toggle"),
    next: () => call("next"),
    prev: () => call("prev"),
    seek: (sec) => call("seek", Math.max(0, num(sec))),
    setVolume: (v) => call("setVolume", Math.max(0, Math.min(1, num(v)))),
    setRate: (r) => call("setRate", Math.max(0.25, Math.min(4, num(r) || 1))),       // скорость воспроизведения
    // Включить этот трек (вместо очереди) с позиции at, секунды. hold — загрузить без звука: файл буферизуется,
    // а play() потом стартует почти сразу («Слушать вместе»: гость готовит трек, пока ведущий его грузит).
    // context — откуда трек для приложения ("room", "other"…). Возвращает промис загрузки.
    playTrack: (t, { at = 0, hold = false, context = "other" } = {}) => call("playTrack", to("track", t), { at: Math.max(0, num(at)), hold: !!hold, context: str(context, 40) }),
    // загрузить заново текущий трек (он ещё не загружен — восстановлен с прошлого запуска): с позиции at, hold — без звука
    reload: (at = 0, hold = false) => call("reload", Math.max(0, num(at)), !!hold),
    // Что сейчас с самим файлом — для модулей, которым важны мгновения (синхронизация «Слушать вместе»):
    // { paused, ended, duration — 0, пока неизвестна; pending — трек показан, но ещё не загружался (с прошлого запуска);
    //   loading — грузится; startAt — с какой позиции он начнёт, пока pending/loading, иначе null;
    //   has — есть ли у приложения сам плеер (false — ещё ни разу не создан); time — позиция самого файла, с;
    //   rate — скорость файла; buffering — данных пока не хватает, чтобы играть дальше; error — файл не загрузился }
    // Нужны модулям, которые проверяют, идёт ли звук на самом деле (Discord: «завис на загрузке — значит, пауза»).
    media: () => ({ paused: true, ended: false, duration: 0, pending: false, loading: false, startAt: null,
      has: true, time: num(call("position")), rate: st.rate, buffering: false, error: false, ...(call("media") || {}) }),
    like: (t) => call("like", t ? to("track", t) : st.track),
    dislike: (t) => call("dislike", t ? to("track", t) : st.track),
    // приложение -> ядро: что изменилось. Событие уходит, только если значение правда поменялось.
    report(p = {}) {
      if ("track" in p) {
        const t = p.track ? to("track", p.track) : null, prev = st.track;
        st.track = t;
        if ((t?.id || "") !== (prev?.id || "") || (t?.provider || "") !== (prev?.provider || "")) {
          // лайк нового трека — не событие «лайкнули», а часть смены трека: запоминаем молча
          if ("liked" in p) st.liked = !!p.liked;
          if ("disliked" in p) st.disliked = !!p.disliked;
          emit("track", { track: t, prev, position: num(p.position), liked: st.liked, disliked: st.disliked });
        }
      }
      if ("playing" in p && !!p.playing !== st.playing) { st.playing = !!p.playing; emit(st.playing ? "play" : "pause", { track: st.track }); emit("playstate", { playing: st.playing, track: st.track }); }
      if ("volume" in p && Math.abs(num(p.volume) - st.volume) > 1e-4) { st.volume = num(p.volume); emit("volume", { volume: st.volume }); }
      if ("liked" in p && !!p.liked !== st.liked) { st.liked = !!p.liked; emit("like", { track: st.track, liked: st.liked }); }
      if ("disliked" in p && !!p.disliked !== st.disliked) { st.disliked = !!p.disliked; emit("dislike", { track: st.track, disliked: st.disliked }); }
      if ("seek" in p) emit("seek", { position: num(p.seek), track: st.track });
      if (p.started) emit("start", { track: to("track", p.started) });      // трек включили (не повтор после сбоя) — для истории
      // откуда звук у текущего трека: id источника (Whisper.sources, например "archive"), "local" — скачанный файл,
      // "provider" — сам сервис. Приходит на каждый трек (и при запасном пути), без сравнения с прошлым.
      if ("source" in p) emit("source", { source: str(p.source, 40), track: st.track });
      if (p.audible) emit("audible", { track: st.track });          // звук реально пошёл (после загрузки, буферизации)
      if ("rate" in p && num(p.rate) > 0 && Math.abs(num(p.rate) - st.rate) > 1e-4) { st.rate = num(p.rate); emit("rate", { rate: st.rate }); }
      if (p.modes && typeof p.modes === "object") {
        // repeat: 0 — нет, 1 — весь список, 2 — один трек; available — можно ли их менять в этом месте (альбом, лайки…)
        const m = { available: !!p.modes.available, shuffle: !!p.modes.shuffle, repeat: [0, 1, 2].includes(p.modes.repeat) ? p.modes.repeat : 0 };
        if (m.available !== st.modes.available || m.shuffle !== st.modes.shuffle || m.repeat !== st.modes.repeat) { st.modes = m; emit("modes", { ...m }); }
      }
      if (p.queue) emit("queue", {});
      if (["track", "playing", "seek", "rate", "modes"].some((k) => k in p)) emit("player:sync", { force: "seek" in p || "rate" in p });
    },
  };

  // что получает подписчик с { replay: true }
  const REPLAY = {
    track: () => ({ track: st.track, prev: null, position: player.state().position, liked: st.liked, disliked: st.disliked }),
    playstate: () => ({ playing: st.playing, track: st.track }),
    volume: () => ({ volume: st.volume }),
    rate: () => ({ rate: st.rate }),
    modes: () => ({ ...st.modes }),
  };

  // ---------- очередь ----------
  let qhost = {};
  const qcall = (name, ...a) => (typeof qhost[name] === "function" ? qhost[name](...a) : undefined);
  // Порядок «что дальше» знает только приложение (у него своё перемешивание, волна, повтор) — ядро спрашивает его.
  const queue = {
    bind(h) { qhost = { ...qhost, ...(h || {}) }; },
    list: () => (qcall("list") || []).map((t) => to("track", t)),
    index: () => { const i = qcall("index"); return Number.isInteger(i) ? i : -1; },
    current: () => st.track,
    // следующие треки в том порядке, в каком заиграют: [{ index — номер в list(), track }]
    upcoming: (max = 50) => (qcall("upcoming", max) || []).map((x) => ({ index: x.index, track: to("track", x.track) })),
    upcomingCount: () => num(qcall("upcomingCount")),
    label: () => str(qcall("label"), 200),          // откуда очередь, для человека: «из лайков», «Моя волна»…
    playAt: (i) => qcall("playAt", i),
    playNext: (t, opts = {}) => qcall("playNext", to("track", t), opts),      // opts.quiet — без подсказки «заиграет следующим»
    add: (t) => qcall("add", to("track", t)),
    remove: (i) => { const t = qcall("remove", i); return t ? to("track", t) : null; },      // убранный трек (чтобы вернуть)
    move: (from, to2) => qcall("move", from, to2),  // перестановка внутри upcoming(): from/to — позиции в нём (0 — ближайший)
    play: (tracks, start = 0, context = null) => qcall("play", (tracks || []).map((t) => to("track", t)), start, context),
  };

  // ---------- источники звука ----------
  // Свои места, откуда можно сыграть трек вместо сервиса: Whisper Archive (core/archive.js) и т.п. Перед загрузкой
  // трека приложение спрашивает Whisper.sources.resolve(track, next): первый источник, у которого трек есть, отдаёт
  // { id: номер у себя, url: поток, blob?: () => Promise<Blob> — запасной путь, если поток не заиграл }.
  // Нет ни у кого — null, играет версия сервиса. Источник не бросает ошибок и не держит дольше нескольких секунд.
  const sources = [];
  const sourceApi = {
    register(src) {
      if (!src || !/^[a-z][a-z0-9-]{0,39}$/.test(src.id || "") || typeof src.resolve !== "function") throw new Error("Whisper: у источника нужны id и resolve()");
      const i = sources.findIndex((x) => x.id === src.id);
      if (i >= 0) sources.splice(i, 1);
      sources.push(src);
      sources.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    },
    list: () => sources.map((x) => ({ id: x.id, name: x.name || x.id })),
    async resolve(t, next = null) {
      const tr = to("track", t), nx = next ? to("track", next) : null;
      for (const src of sources) {
        try {
          const hit = await src.resolve(tr, nx);
          if (hit && hit.url) return { ...hit, source: src.id };
        } catch (e) { console.warn(`Whisper: источник «${src.id}»:`, e); }
      }
      return null;
    },
  };

  // ---------- роли интерфейса (общие темы) ----------
  // Тема пишет CSS не по классам конкретного приложения, а по ролям: [data-w="search"], [data-w="player.volume"].
  // Каждое приложение объявляет, какие его элементы какую роль играют (Whisper.ui.define), а ядро переписывает
  // роль в селекторы приложения: [data-w="search"] -> :is(#search, .lkfindin, …). В DOM ничего не размечается,
  // поэтому роли бесплатны и работают для элементов, которые появляются позже (строки списков, меню).
  //
  // Имена: «часть» через точку (player.volume — часть плеера), «разновидность» через двоеточие
  // (search:global — разновидность поиска). Роль совпадает со всеми своими разновидностями:
  // [data-w="search"] — любой поиск приложения, сколько бы их ни было и где бы они ни стояли;
  // [data-w="search:global"] — только общий поиск по сервису. Части в роль не входят: player ≠ player.play.
  // Роли, которой в приложении нет (например, player.extra у клиента без доп. кнопок), — правило просто
  // ничего не находит: селектор с ней выбрасывается, остальные из того же списка остаются.
  const ROLE_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*(:[a-z][a-z0-9-]*)*$/;
  const roles = new Map();          // роль -> селекторы приложения
  const roleCache = new Map();
  function define(map) {
    for (const [k, v] of Object.entries(map || {})) {
      if (!ROLE_RE.test(k) || typeof v !== "string") { console.warn(`Whisper: роль «${k}» пропущена — неверное имя или селектор`); continue; }
      const sel = v.trim();
      if (!sel) { roles.delete(k); continue; }
      if (sel.includes("::") || /[{};]/.test(sel)) { console.warn(`Whisper: роль «${k}»: в селекторе не может быть псевдоэлементов и {};`); continue; }
      roles.set(k, sel);
    }
    roleCache.clear();
    emit("ui:roles", {});
  }
  function selector(role) {
    if (roleCache.has(role)) return roleCache.get(role);
    const parts = [];
    for (const [k, v] of roles) if (k === role || k.startsWith(role + ":")) parts.push(v);
    const s = parts.join(", ");
    roleCache.set(role, s);
    return s;
  }
  // запятые верхнего уровня (внутри :is(), [attr="a,b"] не в счёт) — как splitTop в theme.js
  function splitTop(s) {
    const out = []; let depth = 0, q = "", cur = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { cur += c; if (c === "\\") cur += s[++i] ?? ""; else if (c === q) q = ""; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  const ATTR = /\[\s*data-w\s*([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s"']+))\s*\]/gi;
  // Список селекторов с ролями -> селекторы приложения. Пустая строка — ни один селектор не подошёл (правило выбросить).
  function resolve(selList) {
    const s = String(selList || "");
    if (!/\[\s*data-w\s*[~|^$*]?=/i.test(s)) return s;
    return splitTop(s).map((one) => {
      let dead = false;
      const out = one.replace(ATTR, (m, op, a, b, c) => {
        const role = (a ?? b ?? c ?? "").trim(), sel = op === "=" && ROLE_RE.test(role) ? selector(role) : "";
        if (!sel) { dead = true; return m; }
        return `:is(${sel})`;
      });
      return dead ? "" : out;
    }).filter(Boolean).join(", ");
  }
  // Общий словарь ролей: на него опираются темы. Приложение объявляет те, что у него есть,
  // и может добавить свои разновидности (search:global:artists) и части (player.extra.timer).
  const VOCAB = {
    "titlebar": "полоса заголовка окна", "titlebar.button": "кнопки окна (свернуть, развернуть, закрыть)",
    "tabs": "полоса вкладок/закладок", "tab": "вкладка", "tab:active": "открытая вкладка",
    "sidebar": "боковая панель", "nav": "кнопка боковой навигации", "nav:active": "текущий раздел",
    "search": "поле поиска (все виды)", "search:global": "поиск по всему сервису", "search:library": "поиск по своей музыке/лайкам", "search:settings": "поиск в настройках и списках",
    "main": "средняя область со страницами", "page.title": "заголовок страницы", "page.subtitle": "строка под заголовком", "page.cover": "картинка в шапке страницы",
    "button": "обычная кнопка в окне", "button:active": "выбранная/главная кнопка", "button:danger": "опасное действие (удалить, выйти)",
    "chip": "переключатель-«таблетка» (фильтры, вкладки страницы)", "chip:active": "выбранный переключатель",
    "tracklist": "список треков", "track": "строка трека", "track:playing": "играющий трек в списке",
    "track.cover": "обложка в строке", "track.title": "название трека в строке", "track.artist": "исполнитель в строке",
    "track.like": "лайк в строке", "track.more": "«⋯» в строке",
    "card": "карточка/блок (настройки, статистика)", "tile": "плитка альбома/плейлиста/артиста",
    "player": "нижняя панель плеера", "player.cover": "обложка играющего трека", "player.title": "название играющего трека", "player.artist": "исполнитель играющего трека",
    "player.info": "блок с названием и исполнителем играющего трека", "player.like": "лайк в плеере", "player.dislike": "«Не нравится» в плеере", "player.controls": "блок кнопок управления",
    "player.play": "пуск/пауза", "player.prev": "предыдущий", "player.next": "следующий",
    "player.mode": "повтор и перемешивание", "player.mode:on": "включённый повтор/перемешивание",
    "player.seek": "полоса воспроизведения", "player.time": "время трека",
    "player.actions": "правый блок плеера", "player.extra": "дополнительные кнопки плеера (свои у каждого приложения)",
    "player.volume": "громкость (весь блок)", "player.volume.button": "кнопка громкости", "player.volume.slider": "ползунок громкости",
    "player.more": "«⋯» в плеере",
    "radio": "кнопка/блок бесконечного потока («Моя волна», «VK Микс»)", "radio.stations": "выбор станции/настроения потока",
    "visualizer": "сцена визуализатора", "visualizer:fullscreen": "визуализатор на весь экран",
    "menu": "всплывающее меню", "menu.item": "пункт меню", "toast": "всплывающая подсказка", "dialog": "окно-диалог", "dialog.backdrop": "затемнение под окном-диалогом", "queue": "панель очереди",
    "fullplayer": "плеер на весь экран", "fullplayer.seek": "полоса воспроизведения на весь экран", "fullplayer.prev": "«назад» на весь экран", "fullplayer.next": "«вперёд» на весь экран", "lyrics": "текст песни", "lyrics.line": "строка текста", "lyrics.line:active": "звучащая строка",
  };
  // Набор интерфейса приложения для общих модулей (панель очереди и т.п.): подсказки, подтверждения, меню трека,
  // ссылки на артистов, обложки, значки. Приложение отдаёт свои (Whisper.ui.provide), чего нет — простая замена,
  // чтобы модуль работал и без них. Модулю не нужно знать showToast/modal/openTrackMenu конкретного приложения.
  const KIT_DEF = {
    toast: (text) => console.info("Whisper:", text),
    confirm: ({ title, text }) => Promise.resolve(window.confirm([title, text].filter(Boolean).join("\n\n"))),
    trackMenu: null,                     // (track, button) — меню «⋯»; нет — кнопки «⋯» в модулях не будет
    closeMenu: () => {},
    artists: (el, t) => { el.textContent = (t?.artists || []).map((a) => a.name).join(", "); },
    image: (src, cls) => { const im = document.createElement("img"); im.alt = ""; im.loading = "lazy"; if (cls) im.className = cls; if (src) im.src = src; return im; },
    decorateRow: () => {},               // (li, track, before) — свои значки в строке трека (например, «скачан»)
    likeButton: null,                    // (track) → кнопка лайка для строки трека (состояние держит приложение); нет — без лайка
    themeExport: null,                   // () → Promise<{ id, name, author, bytes }> — текущий стиль файлом .wmt («Темы комнаты»)
    themeImport: null,                   // (Uint8Array) → Promise<true|false|null> — установить тему из файла и включить её
    // ({ kind: "invite" | "wink", title, body }) → Promise<bool> — системное уведомление, если пользователь его не выключил
    // (приложение само решает, показывать ли при открытом окне); нет — только подсказка в окне
    notify: null,
    icon: (name) => ICONS[name] || "",
    settingsCard: null,                  // (card, { section, first, colbreak }) — встроить карточку настроек модуля; нет — у модуля нет настроек
    accentColors: () => null,            // () => { accent, accent2 } — цвета стиля строго #rrggbb (виджет OBS); нет — цвета по умолчанию
    obsTheme: () => null,                // () => { key, css, settings } — секции whisper-obs текущего стиля (key меняется со стилем)
    rangeFill: () => {},                 // (input[type=range]) — перерисовать заливку ползунка, если приложение рисует её само
    secretSaved: () => {},               // ключ/токен только что сохранён (приложение может предупредить, если хранилище небезопасное)
  };
  const ICONS = {
    more: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>',
    grip: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M9 5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM9 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM9 16a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>',
  };
  let kitApp = {};
  const kit = new Proxy({}, { get: (_, k) => (typeof kitApp[k] === "function" ? kitApp[k] : KIT_DEF[k]) });
  // Дополнительные пункты меню «⋯» трека от общих модулей («Сохранить в архив» и т.п.). Само меню — приложения:
  // оно в нужном месте зовёт Whisper.ui.trackMenu.build(трек, ctx), а набор интерфейса даёт kit.menu(трек, ctx) —
  // как добавить пункт, подпись, вложенный список (описание — docs/CORE.md). Нет kit.menu — пунктов модулей не будет.
  const menuExt = [];
  // slot — где в меню: "top" — самый верх (блок «Слушать вместе»), "main" (по умолчанию) — рядом с плейлистами.
  // build пункта возвращает true, если что-то добавил; trackMenu.build — сколько таких (чтобы поставить разделитель).
  const trackMenu = {
    add(ext) { if (ext && typeof ext.build === "function") { const i = menuExt.findIndex((x) => x.id === ext.id); if (i >= 0) menuExt.splice(i, 1); menuExt.push(ext); } },
    build(raw, ctx = null, slot = "main") {
      const list = menuExt.filter((x) => (x.slot || "main") === slot);
      if (!list.length || typeof kitApp.menu !== "function") return 0;
      const t = to("track", raw), m = kitApp.menu(raw, ctx);
      let n = 0;
      for (const ext of list) { try { if (ext.build(t, m, ctx) !== false) n++; } catch (e) { console.error(`Whisper: пункт меню «${ext.id}» упал:`, e); } }
      return n;
    },
  };
  const ui = {
    define, resolve, selector, kit, trackMenu,
    provide: (o) => { kitApp = { ...kitApp, ...(o || {}) }; },
    roles: () => Object.fromEntries(roles),
    vocabulary: () => ({ ...VOCAB }),
    has: (role) => !!selector(role),
    // элементы роли в документе — для модулей, которым нужно найти «все поиски» или «кнопку громкости» в любом приложении
    all: (role, root = document) => { const s = selector(role); try { return s ? [...root.querySelectorAll(s)] : []; } catch { return []; } },
  };

  // ---------- приложение ----------
  // Кто мы: id секции темы этого приложения (css <id>), название, версия. Темы читают общую секцию «whisper-core»
  // и, если есть, секцию приложения поверх неё.
  // storage — приставка ключей localStorage для общих модулей (история: storage + "history"), чтобы данные
  // старых версий приложения не потерялись (у Whisper Yandex — «ym_»)
  const app = { id: "", name: "", version: "", storage: "whisper_" };

  window.Whisper = Object.freeze({
    version: "0.1.0",
    CORE_SECTION: "whisper-core",
    app,
    setApp: (o) => { Object.assign(app, { id: str(o?.id, 40), name: str(o?.name, 80), version: str(o?.version, 40), storage: /^[\w.-]{1,20}$/.test(o?.storage || "") ? o.storage : app.storage }); emit("app", { ...app }); },
    on, once, emit, off: (ev, fn) => subs.get(ev)?.delete(fn),
    entity, cover, to,
    registerProvider, useProvider, provider: () => cur, providers: () => [...providers.values()], caps,
    player, queue, ui, sources: sourceApi,
    modules: {},                         // общие модули кладут сюда свой API: Whisper.modules.archive.login() и т.п.
  });
})();
