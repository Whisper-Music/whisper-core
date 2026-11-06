// core/together.js — «Слушать вместе»: комнаты совместного прослушивания через сервер Whisper Archive
// (/api/rooms, Rust: whisper::rooms::wa_room_*). Общий модуль ядра (docs/CORE.md «Общие модули»): работает только через
// window.Whisper — плеер, очередь, роли, набор интерфейса; формат трека для сервера — у провайдера (toRoom / fromRoom).
//
// * Ведущий создаёт комнату и даёт друзьям код. Что у него играет (трек, позиция, пауза, скорость), уходит на сервер.
// * Гости ждут изменений (long-poll) и включают тот же трек у себя — каждый со своего аккаунта сервиса,
//   звук никуда не передаётся. Позиция выравнивается по времени сервера; расхождение больше 1,5 с — перемотка.
// * Гость может отойти: поставить паузу или включить своё — тогда он перестаёт следовать за ведущим,
//   пока не нажмёт «Вернуться к ведущему». Перемотка и «вперёд/назад» у гостя отключены.
// * Гости предлагают треки (меню «⋯» → «Предложить в комнату»), ведущий включает их сразу, ставит следующими или убирает.
(() => {
  const W = window.Whisper;
  if (!W) { console.error("together.js: нет ядра Whisper — подключи core/whisper-core.js раньше"); return; }
  const kit = W.ui.kit, P = W.player;
  const { invoke } = window.__TAURI__.core;
  const showToast = (...a) => kit.toast(...a), modal = (o) => kit.confirm(o);
  const $t = (s, el = document) => el.querySelector(s);
  const roleEl = (r) => W.ui.all(r)[0] || null;
  // Каждое действие с комнатой — своя команда Rust (rust/whisper/rooms.rs: wa_room_*); путь к API собирает Rust из кода комнаты.
  const ROOM_RE = /^\/api\/rooms(?:\/([A-Z0-9]{4,12})(?:\/(join|leave|state|suggest|host|missing)|\/suggestions\/([A-Za-z0-9]{1,32})\/dismiss)?)?$/;
  function call(method, path, body, since) {
    const m = ROOM_RE.exec(path);
    if (!m) return Promise.reject(new Error("Недопустимый запрос к комнате"));
    const [, code, act, sid] = m;
    let p;
    if (!code) p = method === "POST" ? invoke("wa_room_create") : null;
    else if (sid) p = method === "POST" ? invoke("wa_room_dismiss", { code, id: sid }) : null;
    else if (!act) p = method === "GET" ? invoke("wa_room_get", { code, since: since ?? null }) : null;
    else if (method === "POST") {
      p = act === "state" ? invoke("wa_room_state", { code, state: body ?? {} })
        : act === "suggest" ? invoke("wa_room_suggest", { code, track: body ?? {} })
        : act === "host" ? invoke("wa_room_transfer", { code, memberId: String(body?.memberId ?? "") })
        : act === "missing" ? invoke("wa_room_missing", { code, trackId: String(body?.trackId ?? "") })
        : invoke(act === "join" ? "wa_room_join" : "wa_room_leave", { code });
    }
    return p ? Promise.resolve(p) : Promise.reject(new Error("Недопустимый запрос к комнате"));
  }
  const SYNC_TOL = 1500;          // мс расхождения с ведущим, после которых гость перематывается

  let room = null;                // последний снимок комнаты с сервера
  let code = "";
  let offset = 0;                 // серверное время − локальное, мс
  let pollGen = 0;
  let follow = true;              // гость следует за ведущим
  let syncing = 0;                // сколько действий над плеером сейчас делает сама синхронизация
  let mySpeed = null;             // скорость гостя до входа — вернём при выходе
  let hostLast = "", hostTimer = 0, hostSentAt = 0;
  let resumeUntil = 0;            // ведущий после перезагрузки окна: до этого момента (или до «audible») состояние не шлём
  let panel = null;
  // Комната переживает перезагрузку окна (F5, восстановление настроек): код лежит в sessionStorage — он живёт, пока
  // открыто окно, и пропадает при выходе из приложения. Сервер сам убирает ушедших (гость — 75 с, ведущий — 120 с).
  const KEEP_KEY = "whisper_room";
  const keep = () => { try { if (inRoom()) sessionStorage.setItem(KEEP_KEY, JSON.stringify({ code, host: isHost(), follow, at: Date.now() })); } catch {} };
  const unkeep = () => { try { sessionStorage.removeItem(KEEP_KEY); } catch {} };
  // ведущий: «Ставить в очередь» — предложения сами встают в очередь по одному, когда доигрывает текущий трек
  let autoQ = false;
  try { autoQ = localStorage.getItem("ym_room_autoq") === "1"; } catch {}
  const seenSug = new Set();      // предложения, о которых ведущему уже сказали
  const taken = new Set();        // предложения, уже поставленные в очередь (пока сервер их не убрал)

  const isHost = () => !!room?.isHost;
  const inRoom = () => !!room && !room.closed;
  const nowSrv = () => Date.now() + offset;

  async function req(method, path, body, since) {
    const r = await call(method, path, body, since);
    let data = null;
    try { data = r.body ? JSON.parse(r.body) : null; } catch {}
    if (r.status >= 200 && r.status < 300) return data;
    const e = new Error(data?.message || `Сервер ответил HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }

  // ---------- трек ↔ формат сервера ----------
  // Как трек сервиса записать для сервера комнат и обратно — знает провайдер (toRoom / fromRoom). Нет — общие поля.
  // provider — чей это номер трека («yandex», «vk»): гость с другим сервисом ищет такой же трек у себя (resolveRoom)
  const toRoomTrack = (t) => {
    const e = W.to("track", t), p = W.provider();
    const r = p?.toRoom ? p.toRoom(e)
      : { id: e.id, albumId: e.album?.id || null, title: (e.title || "Без названия").slice(0, 300), version: e.version || null,
        artists: e.artists.slice(0, 10).map((a) => ({ id: a.id || null, name: a.name })), coverUri: null, durationMs: Math.round(e.durationMs) };
    const pid = String(p?.id || "");
    if (r && !r.provider && /^[a-z0-9-]{1,20}$/.test(pid)) r.provider = pid;
    return r;
  };
  // → трек сервиса («сырой», как его понимает приложение)
  const fromRoomTrack = (r) => {
    const p = W.provider();
    if (p?.fromRoom) return p.fromRoom(r);
    return { id: r.id, title: r.title, version: r.version || undefined, durationMs: r.durationMs, artists: (r.artists || []).map((a) => ({ id: a.id || undefined, name: a.name })) };
  };
  // archiveId — трек есть в Whisper Archive у ведущего: гость играет его оттуда (core/archive.js смотрит waShared),
  // даже если в его собственном архиве такого трека нет. Сервер пускает к файлу участников комнаты, пока он играет.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const roomEntity = (r, extra) => W.to("track", { ...fromRoomTrack(r), ...(UUID.test(String(r?.archiveId || "")) ? { waShared: String(r.archiveId) } : {}), ...extra });
  const archiveIdOf = (t) => {
    const a = W.modules.archive;
    if (!a?.enabled?.()) return null;
    // гостям — только свои и публичные треки архива (лайкнутый приватный альбом сервер в комнату не пустит)
    try { const id = (a.lookupShare || a.lookup)(t)?.id; return UUID.test(String(id || "")) ? String(id) : null; } catch { return null; }
  };
  const curTrack = () => P.state().track;
  const account = () => W.provider()?.accountLabel || "аккаунта";

  // ---------- трек комнаты у себя: «мягкая связь» сервисов и треки, которых нет ----------
  // У ведущего и гостя могут быть разные сервисы (Whisper Yandex и Whisper VK) или разные страны: номер трека ведущего
  // у гостя либо чужой, либо трек недоступен. Порядок:
  //   1. тот же сервис — номер как есть, если трек у тебя доступен;
  //   2. иначе — поиск на своём сервисе: то же название, общий исполнитель, та же версия, длина ±15 с;
  //   3. иначе — свой Whisper Archive (то же название и исполнитель);
  //   4. иначе — трека нет: гость сообщает серверу (/missing), а ведущий с галочкой «Делиться треками из архива»
  //      сохраняет трек в свой архив — тогда у гостя он играет оттуда (archiveId → waShared, core/archive.js).
  // Ведущий так же сопоставляет предложения гостей с другим сервисом.
  const myProv = () => String(W.provider()?.id || "");
  const nrm = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/ё/g, "е")
    .replace(/[(\[]\s*(?:feat|ft|featuring)\.?\s[^)\]]*[)\]]/giu, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  // исполнитель целиком и по частям: «A & B» совпадает с «B», а «Король и Шут» — целиком
  const artSet = (list) => new Set((list || []).flatMap((a) => { const n = String(a?.name || "");
    return [n, ...n.split(/\s*(?:[,;&/+]|\s(?:feat|ft|featuring|x|х|vs)\.?\s)\s*/iu)]; }).map(nrm).filter(Boolean));
  // 0 — не тот трек; больше — точнее совпадение
  function sameTrack(a, b) {
    const ta = nrm(a?.title);
    if (!ta || ta !== nrm(b?.title)) return 0;
    const A = artSet(a.artists), B = artSet(b.artists);
    if (![...A].some((x) => B.has(x))) return 0;
    const va = nrm(a.version), vb = nrm(b.version);
    if (va && vb && va !== vb) return 0;                // «Remix» и оригинал — разные треки
    let s = 2 + (va === vb ? 1 : 0);
    const da = +a.durationMs || 0, db = +b.durationMs || 0;
    if (da && db) { const d = Math.abs(da - db); if (d > 15000) return 0; if (d < 4000) s++; }
    return s;
  }
  const rkey = (r) => `${r?.provider || ""}:${r?.id ?? ""}`;
  const resolved = new Map();      // rkey → Promise<{ track, archive, how }>
  const settled = new Map();       // rkey → тот же результат, когда он уже есть (для синхронных мест: take())
  function resolveRoom(r) {
    const k = rkey(r);
    if (resolved.has(k)) return resolved.get(k);
    const p = (async () => {
      const prov = W.provider();
      const want = W.to("track", fromRoomTrack(r));
      if (!r?.provider || r.provider === myProv()) {
        try {
          const [t] = typeof prov?.tracks === "function" ? await prov.tracks([String(r.id)]) : [];
          if (t?.id && t.available !== false) return { track: t, how: "same" };
        } catch (e) {
          // сеть и прочие сбои — не знаем, играем номер как раньше; «нет такого» (400/404) — ищем дальше
          if (!/^HTTP (400|404)\b/.test(String(e?.message || e))) return { track: null, how: "error" };
        }
      }
      if (typeof prov?.search === "function") {
        const q = [want.artists.slice(0, 2).map((a) => a.name).join(" "), want.title].join(" ").trim();
        try {
          const res = await prov.search(q, "track");
          let best = null, bs = 0;
          for (const t of res?.tracks || []) {
            if (t?.available === false) continue;
            const s = sameTrack(t, want);
            if (s > bs) { bs = s; best = t; }
          }
          if (best) return { track: best, how: "match" };
        } catch { return { track: null, how: "error" }; }       // поиск не ответил — «нет трека» не утверждаем
      }
      try { const own = W.modules.archive?.lookup?.(want); if (UUID.test(String(own?.id || ""))) return { track: null, archive: String(own.id), how: "archive" }; } catch {}
      return { track: null, how: "missing" };
    })();
    resolved.set(k, p);
    p.then((x) => {
      if (x.how === "error") { resolved.delete(k); return; }      // сбой сети — в следующий раз проверим снова
      settled.set(k, x);
      if (settled.size > 300) settled.delete(settled.keys().next().value);
    });
    if (resolved.size > 300) resolved.delete(resolved.keys().next().value);
    return p;
  }
  // Что гость включает вместо трека комнаты r; null — такого трека у него нет нигде.
  const sharedOf = (r) => (UUID.test(String(r?.archiveId || "")) ? String(r.archiveId) : null);
  async function guestEntity(r) {
    const x = await resolveRoom(r), sh = sharedOf(r);
    if (x.track) { const raw = x.track.raw || x.track; return W.to("track", sh ? { ...raw, waShared: sh } : raw); }
    if (sh) return roomEntity(r);                                       // у тебя нет — играет из архива ведущего
    if (x.archive) return W.to("track", { ...fromRoomTrack(r), waShared: x.archive });   // из своего архива
    if (x.how === "error") return roomEntity(r);                        // проверить не вышло — как раньше
    return null;
  }
  // Предложение гостя у ведущего: уже сопоставлено — свой трек; нет на площадке — null; ещё не знаем — как прислали.
  function sugEntity(s) {
    const x = settled.get(rkey(s.track));
    if (x?.track) return W.to("track", { ...(x.track.raw || x.track), _room: true });
    if (x?.archive) return W.to("track", { ...fromRoomTrack(s.track), waShared: x.archive, _room: true });
    if (x && x.how === "missing") return null;
    return roomEntity(s.track, { _room: true });
  }

  // ведущий: треки, которыми поделился с гостями (id трека сервиса → id файла: в кэше комнаты или в архиве)
  // shareOn — «Делиться треками, которых нет у гостей»: файл уходит во временный кэш комнаты на сервере архива
  // (provider.roomCache) и пропадает вместе с комнатой; shareSave — «Сохранять их в мой архив»: вместо кэша трек
  // ложится в альбом «Слушать вместе» (Whisper.modules.archive.share) и остаётся у тебя.
  let shareOn = false, shareSave = false;
  try { shareOn = localStorage.getItem("ym_room_share") === "1"; shareSave = localStorage.getItem("ym_room_share_save") === "1"; } catch {}
  const canCache = () => typeof W.provider()?.roomCache === "function";
  const canSave = () => typeof W.provider()?.archiveSave === "function";
  const canShare = () => !!W.modules.archive?.connected?.() && (canCache() || canSave());
  const roomShared = new Map();
  let shareBusy = "", shareAsked = "", shareFailed = "";

  // ---------- ведущий: что играет → на сервер ----------
  // Пока у ведущего грузится новый трек (Whisper.player.media().loading), у плеера ещё позиция прошлого трека. Раньше она уходила
  // гостям вместе с новым треком — и гость начинал новый трек с середины, а потом прыгал в начало.
  // Теперь на время загрузки: «новый трек, позиция старта, пауза». Гость в это время грузит трек без звука,
  // а когда у ведущего заиграет (roomOnPlaying ниже), гостю приходит «играет» — и трек у него уже готов.
  function hostState() {
    const ps = P.state(), md = P.media(), t = ps.track;
    if (!t) return null;
    const pos = md.startAt != null ? md.startAt : ps.position;
    const track = toRoomTrack(t), wa = roomShared.get(String(t.id))?.id || archiveIdOf(t);
    if (wa) track.archiveId = wa;
    return {
      track,
      positionMs: Math.max(0, pos * 1000),
      playing: !md.loading && !md.paused,
      rate: ps.rate > 0 ? ps.rate : 1,
    };
  }
  function hostPush(force) {
    if (!inRoom() || !isHost()) return;
    // ведущий вернулся после перезагрузки окна: пока трек комнаты у него не заиграл, гостям ничего не шлём —
    // иначе они получили бы «пауза» (плеер после перезагрузки стоит) и остановились бы
    if (resumeUntil > Date.now()) return;
    const s = hostState();
    if (!s) return;
    const key = JSON.stringify({ ...s, positionMs: 0 });
    if (!force && key === hostLast) return;
    hostLast = key;
    // не чаще ~3 раз в секунду: подряд идущие изменения (перемотка ползунком) сливаются в одно
    clearTimeout(hostTimer);
    const wait = Math.max(0, 350 - (Date.now() - hostSentAt));
    hostTimer = setTimeout(() => {
      hostSentAt = Date.now();
      const st = hostState();
      if (st) req("POST", `/api/rooms/${code}/state`, st).catch((e) => { if (e.status === 404) gone("Комната закрыта"); });
    }, wait);
  }
  // раз в 10 с — позиция заново (на случай расхождения часов и как знак «ведущий на месте»)
  setInterval(() => { if (inRoom() && isHost()) hostPush(true); }, 10000);

  // ---------- гость: трека нет у себя ----------
  // guestFor — что у гостя означает текущий трек комнаты: { key, id своего трека, ent, missing }. Ключ включает archiveId:
  // ведущий поделился треком из архива — ключ меняется, и трек выясняется заново (теперь он играет из архива ведущего).
  const pbKey = (r) => `${rkey(r)}:${r?.archiveId || ""}`;
  let guestFor = null, guestResolving = "", missingNote = "";
  // какой номер трека сейчас должен играть у гостя (свой, если сопоставлен; иначе — номер ведущего)
  const guestWantId = (pb) => (guestFor && guestFor.key === pbKey(pb?.track) ? guestFor.id : String(pb?.track?.id ?? ""));
  function onMissing(r) {
    if (!P.media().paused) P.pause();                    // своё не играет поверх комнаты; паузой это не считается (syncing)
    const k = rkey(r);
    if (missingNote === k) return;
    missingNote = k;
    req("POST", `/api/rooms/${code}/missing`, { trackId: String(r.id) }).catch(() => {});
    showToast(`«${r.title}» нет на твоей площадке — ждём, пока ведущий поделится им`, 7000);
    paint();
  }
  // трек комнаты не заиграл с сервиса гостя (ошибка «не найден» и т.п.) — тоже «нет у меня»
  let lastSource = "";
  W.on("source", ({ source }) => { lastSource = source || ""; });
  setInterval(() => {
    if (!inRoom() || isHost() || !follow || syncing || !guestFor || guestFor.missing) return;
    const pb = room.playback;
    if (!pb || guestFor.key !== pbKey(pb.track) || sharedOf(pb.track)) return;
    const md = P.media(), t = curTrack();
    if (md.error && lastSource === "provider" && t && String(t.id) === guestFor.id) {
      guestFor.missing = true;
      settled.set(rkey(pb.track), { track: null, how: "missing" });
      resolved.set(rkey(pb.track), Promise.resolve({ track: null, how: "missing" }));
      syncing++;
      try { onMissing(pb.track); } finally { setTimeout(() => { syncing = Math.max(0, syncing - 1); }, 400); }
    }
  }, 2000);

  // ---------- ведущий: у гостя нет трека → поделиться из своего архива ----------
  function onMissingHost() {
    const ms = room?.missing, t = curTrack();
    if (!ms?.members?.length || !t || String(toRoomTrack(t).id) !== String(ms.trackId)) return;
    const k = String(t.id);
    // Уже поделились, но сервер этот файл не принял (кэш комнаты истёк — трек давно не играл): забываем и делимся заново.
    // Пока свежее (15 с) — состояние с archiveId ещё может быть в пути.
    const sh = roomShared.get(k);
    if (sh && String(room.playback?.track?.archiveId || "") !== sh.id && Date.now() - sh.at > 15000) roomShared.delete(k);
    if (roomShared.has(k) || archiveIdOf(t)) return;    // уже играет у гостей из архива (или вот-вот)
    const who = ms.members.join(", ");
    const can = canShare();
    // сам — только если прошлая попытка с этим треком не сорвалась (иначе ошибка повторялась бы с каждым снимком)
    if (shareOn && can && shareFailed !== k) return shareTrack(t);
    if (shareAsked === k) return;
    shareAsked = k;
    showToast(`У ${who} нет «${t.title}» на площадке` + (can ? "" : " — поделиться можно через Whisper Archive"), 9000,
      can ? { action: { label: "Поделиться", fn: () => shareTrack(t) } } : {});
  }
  async function shareTrack(t) {
    const k = String(t.id);
    if (shareBusy === k || roomShared.has(k)) return;
    shareBusy = k;
    if (panel) paint();
    // уже есть в твоём архиве — отдаём его; иначе в кэш комнаты (или в архив, если так выбрано / кэша сервис не умеет)
    let own = null;
    try { const a = W.modules.archive; own = (a?.lookupShare || a?.lookup)?.(t)?.id; } catch {}
    const save = !UUID.test(String(own || "")) && canSave() && (shareSave || !canCache());
    showToast(save ? `«${t.title}» сохраняется в твой архив для гостей…` : `«${t.title}» передаётся гостям через архив…`, 0);
    try {
      let id = UUID.test(String(own || "")) ? String(own) : null;
      if (!id && save) id = await W.modules.archive.share(t);
      else if (!id) {
        const r = await W.provider().roomCache(t, code);
        let body = null;
        try { body = r?.body ? JSON.parse(r.body) : null; } catch {}
        if (!(r?.status >= 200 && r.status < 300)) throw new Error(body?.message || body?.title || `сервер ответил HTTP ${r?.status}`);
        id = String(body?.id || "");
        if (!UUID.test(id)) throw new Error("сервер не вернул номер файла");
      }
      roomShared.set(k, { id, at: Date.now() });
      if (roomShared.size > 200) roomShared.delete(roomShared.keys().next().value);
      if (inRoom() && isHost() && String(curTrack()?.id) === k) hostPush(true);
      showToast(save || own ? `«${t.title}» играет у гостей из твоего архива` : `«${t.title}» играет у гостей — файл живёт, пока открыта комната`, 3500, { kind: "ok" });
    } catch (e) {
      shareFailed = k;
      showToast("Не удалось поделиться треком: " + String(e?.message || e || "ошибка"), 8000,
        { kind: "err", action: { label: "Ещё раз", fn: () => shareTrack(t) } });
    } finally { if (shareBusy === k) shareBusy = ""; paint(); }
  }
  function setShareOn(on) {
    shareOn = !!on;
    try { localStorage.setItem("ym_room_share", shareOn ? "1" : "0"); } catch {}
    if (shareOn) onMissingHost();
    paint();
  }
  function setShareSave(on) {
    shareSave = !!on;
    try { localStorage.setItem("ym_room_share_save", shareSave ? "1" : "0"); } catch {}
    paint();
  }

  // ---------- гость: включить то же, что у ведущего ----------
  function expectedMs(pb) {
    return pb.positionMs + (pb.playing ? (nowSrv() - pb.at) * (pb.rate || 1) : 0);
  }
  // tol — допустимое расхождение; сразу после старта трека (roomOnPlaying) оно меньше, чтобы догнать время загрузки
  async function guestApply(tol = SYNC_TOL) {
    if (!inRoom() || isHost() || !follow) return;
    let pb = room.playback;
    if (!pb) return;
    syncing++;
    try {
      if (Math.abs((P.state().rate || 1) - (pb.rate || 1)) > 0.001) P.setRate(pb.rate || 1);
      // трек комнаты → свой трек (resolveRoom): у гостя может быть другой сервис или трека может не быть вовсе
      const key = pbKey(pb.track);
      if (guestFor?.key !== key) {
        if (guestResolving === key) return;               // уже выясняем — второй запуск не нужен
        guestResolving = key;
        let ent = null;
        try { ent = await guestEntity(pb.track); } finally { if (guestResolving === key) guestResolving = ""; }
        if (!inRoom() || isHost() || !follow || pbKey(room.playback?.track) !== key) return;
        pb = room.playback;                                // пока выясняли, позиция могла обновиться
        guestFor = { key, id: ent ? String(ent.id) : "", ent, missing: !ent };
        if (ent) missingNote = "";
      }
      if (guestFor.missing) { onMissing(pb.track); return; }
      const t = curTrack();
      if (!t || String(t.id) !== guestFor.id) {
        // ведущий ещё грузит трек или на паузе — грузим без звука (hold), иначе включаем сразу
        await P.playTrack(guestFor.ent, { at: Math.max(0, expectedMs(pb) / 1000), hold: !pb.playing, context: "room" });
        return;
      }
      let md = P.media();
      if (md.pending) { await P.reload(Math.max(0, expectedMs(pb) / 1000), !pb.playing); return; }
      // этот трек ещё грузится: плеер сам решит, стартовать ли (wantsPlay), а время догонит событие «audible»
      if (md.loading) return;
      const want = expectedMs(pb);
      const starting = pb.playing && md.paused;          // трек уже загружен без звука — стартуем точно с нужного места
      const known = md.duration > 0;
      if ((known || starting) && Math.abs(P.state().position * 1000 - want) > (starting ? 250 : tol)) P.seek(Math.max(0, want / 1000));
      md = P.media();
      if (pb.playing && md.paused) await P.play();
      else if (!pb.playing && !md.paused) P.pause();
    } finally {
      setTimeout(() => { syncing = Math.max(0, syncing - 1); }, 400);   // события pause/play от синхронизации ещё долетают
    }
  }
  setInterval(() => { if (inRoom() && !isHost() && follow && !syncing) guestApply(); }, 3000);

  // плеер приложения: трек загружался «без звука», а ведущий тем временем уже включил — тогда не держать, а играть
  const wantsPlay = () => inRoom() && !isHost() && follow && !!room.playback?.playing;
  // у этого клиента трек реально заиграл (report({ audible }) — событие «audible»)
  W.on("audible", () => {
    if (!inRoom()) return;
    if (isHost()) { resumeUntil = 0; hostPush(true); return; }        // гостям — «играет» с точной позицией, как только звук пошёл
    if (follow) setTimeout(() => guestApply(500), 120);     // догнать ведущего на время своей загрузки
  });

  // гость сам поставил паузу или включил другой трек — перестаём тянуть его за ведущим
  let rejoinAt = 0;               // момент «Вернуться в комнату»: пару секунд не считаем паузу/смену трека уходом
  function detach(why) {
    if (!inRoom() || isHost() || !follow || syncing) return;
    if (Date.now() - rejoinAt < 3000) return;
    follow = false;
    showToast(why + " — комната играет дальше без тебя", 6000, { action: { label: "Вернуться", fn: rejoin } });
    paint();
  }
  function rejoin() {
    if (!inRoom() || isHost()) return;
    follow = true; rejoinAt = Date.now();
    paint();
    guestApply(300).catch(() => {});
  }

  // ---------- связь с сервером ----------
  async function pollLoop(gen) {
    let fails = 0;
    while (gen === pollGen && room && !room.closed) {
      try {
        const snap = await req("GET", `/api/rooms/${code}`, null, room.version);
        if (gen !== pollGen) return;
        fails = 0;
        // сервер ставит serverNow в момент ответа (а не начала ожидания) — сравниваем с моментом получения
        offset = snap.serverNow - Date.now();
        accept(snap);
      } catch (e) {
        if (gen !== pollGen) return;
        if (e.status === 404 || e.status === 403) return gone(e.status === 404 ? "Комната закрыта" : e.message);
        if (++fails >= 2) setStatus("Нет связи с сервером, идёт переподключение…");
        await new Promise((r) => setTimeout(r, Math.min(15000, 1500 * fails)));
      }
    }
  }
  function accept(snap) {
    const prevPb = JSON.stringify(room?.playback || null);
    const wasHost = room ? !!room.isHost : null;
    room = snap; code = snap.code;
    if (snap.closed) return gone("Ведущий закрыл комнату");
    setStatus("");
    if (wasHost !== null && wasHost !== isHost()) roleChanged();
    if (!isHost() && JSON.stringify(snap.playback || null) !== prevPb) guestApply();
    if (isHost()) { onSuggestions(); onMissingHost(); }
    // в комнате кто-то новый — он теперь в друзьях (сервер записал при его входе)
    if ((snap.members || []).some((m) => !m.isMe && memberId(m) != null && !friends.some((f) => String(f.id) === String(memberId(m))))) {
      setTimeout(() => loadFriends(), 1500);
    }
    paint();
  }

  // ---------- передача ведущего ----------
  // Сервер отдаёт у участника id (members[].id) и принимает POST /api/rooms/{code}/host {memberId}.
  const memberId = (m) => m?.id ?? m?.userId ?? m?.memberId ?? null;
  let confirmFor = null;          // кому ведущий собирается передать управление (подтверждение в окне)
  function roleChanged() {
    follow = true; hostLast = ""; confirmFor = null;
    guestFor = null; missingNote = ""; shareAsked = "";
    document.body.classList.toggle("room-guest", !isHost());
    if (isHost()) {
      mySpeed = null;
      taken.clear();
      for (const s of room.suggestions || []) if (s?.id) seenSug.add(s.id);   // старые предложения — без всплывашек
      showToast("Теперь ты ведущий — музыкой в комнате управляешь ты", 4000, { kind: "ok" });
      hostPush(true);
    } else {
      mySpeed = P.state().rate;
      const h = (room.members || []).find((m) => m.isHost);
      showToast(`Ведущий теперь — ${h?.nickname || "другой участник"}`, 3500, { kind: "ok" });
    }
    W.emit("room", { ...roomEvent(), roleChanged: true });
  }
  async function transfer(m) {
    const id = memberId(m);
    if (!inRoom() || !isHost() || !id) return;
    confirmFor = null;
    hostPush(true);                // новый ведущий подхватит точную позицию
    try {
      const snap = await req("POST", `/api/rooms/${code}/host`, { memberId: String(id) });
      if (snap?.code) { if (snap.serverNow) offset = snap.serverNow - Date.now(); accept(snap); }
    } catch (e) {
      setStatus(e.status === 404 || e.status === 405 ? "Сервер комнат пока не умеет передавать ведущего" : e.message);
      paint();
    }
  }

  // ---------- ведущий: новые предложения ----------
  const sugList = () => (room?.suggestions || []).filter((s) => s?.id && s.track);
  function onSuggestions() {
    const list = sugList();
    const ids = new Set(list.map((s) => s.id));
    for (const id of taken) if (!ids.has(id)) taken.delete(id);
    // заранее сопоставляем предложения со своим сервисом (у гостя может быть другой) — к «Следующим» результат уже готов
    for (const s of list) if (!settled.has(rkey(s.track))) resolveRoom(s.track).then(() => { if (panel) paint(); }).catch(() => {});
    const fresh = list.filter((s) => !seenSug.has(s.id));
    for (const s of fresh) seenSug.add(s.id);
    if (!fresh.length) return;
    // ничего не играет (очередь пуста) — с галочкой включаем предложенное сразу
    if (autoQ && W.queue.index() < 0) take();
    const s = fresh[fresh.length - 1];
    const who = s.from || "Гость";
    const title = `«${s.track.title}»`;
    if (autoQ) {
      showToast(fresh.length > 1 ? `Предложено треков: ${fresh.length} — встанут в очередь` : `${who}: ${title} — встанет в очередь`,
        5000, { kind: "ok", action: { label: "Комната", fn: () => { if (!panel) open(); } } });
    } else if (fresh.length > 1) {
      showToast(`Новых предложений: ${fresh.length}`, 6000, { action: { label: "Открыть", fn: () => { if (!panel) open(); } } });
    } else {
      showToast(`${who} предлагает ${title}`, 7000, {
        action: { label: "Следующим", fn: () => queueSug(s) },
      });
    }
    // окно свёрнуто или в фоне — мигнуть значком на панели задач
    if (!document.hasFocus()) {
      try { window.__TAURI__?.window?.getCurrentWindow?.().requestUserAttention(2)?.catch?.(() => {}); } catch {}
    }
  }
  // поставить предложение сразу за текущим треком и убрать его из списка
  function queueSug(s, quiet = false) {
    if (!s || taken.has(s.id)) return false;
    const ent = sugEntity(s);
    if (!ent) { if (!quiet) showToast(`«${s.track.title}» нет на твоей площадке`, 4000, { kind: "err" }); return false; }
    taken.add(s.id);
    W.queue.playNext(ent, { quiet: true });      // _room — трек из комнаты (не «волны»)
    dismiss(s.id);
    if (!quiet) showToast(`«${s.track.title}» заиграет следующим`, 2500, { kind: "ok" });
    return true;
  }
  // плеер приложения зовёт перед переходом к следующему треку: берём самое раннее предложение
  const take = () => {
    if (!autoQ || !inRoom() || !isHost()) return false;
    const s = sugList().find((x) => !taken.has(x.id) && sugEntity(x));      // которых нет на твоей площадке — пропускаем
    return s ? queueSug(s, true) : false;
  };
  function setAutoQ(on) {
    autoQ = !!on;
    try { localStorage.setItem("ym_room_autoq", autoQ ? "1" : "0"); } catch {}
    if (autoQ && sugList().some((x) => !taken.has(x.id))) showToast("Предложения встанут в очередь после текущего трека", 3000, { kind: "ok" });
    paint();
  }

  // restored — возврат после перезагрузки окна: гость, который «слушал своё», так и остаётся отошедшим
  function start(snap, restored = false) {
    room = snap; code = snap.code; hostLast = "";
    if (!restored) follow = true;
    seenSug.clear(); taken.clear();
    for (const s of snap.suggestions || []) if (s?.id) seenSug.add(s.id);
    offset = (snap.serverNow || Date.now()) - Date.now();
    if (!isHost()) mySpeed = P.state().rate;
    document.body.classList.add("in-room");
    document.body.classList.toggle("room-guest", !isHost());
    const gen = ++pollGen;
    pollLoop(gen);
    if (isHost()) hostPush(true); else guestApply();
    paint();
    setTimeout(() => { if (gen === pollGen) checkPing(false); }, 2000);   // свой пинг — серверу сразу, остальным видно
    setTimeout(() => loadFriends(true), 2500);                            // вошёл к людям — они теперь в друзьях
    inboxKick();
  }
  function gone(msg) {
    pollGen++;
    const wasGuest = room && !room.isHost;
    room = null; code = ""; follow = true; resumeUntil = 0;
    guestFor = null; missingNote = ""; shareAsked = ""; roomShared.clear();
    myPing = 0; pingSrv = null; pingShowUntil = 0; pingErr = ""; loadChecked = ""; clearTimeout(pingHideTimer);
    unkeep();
    document.body.classList.remove("in-room", "room-guest");
    if (wasGuest && mySpeed != null) P.setRate(mySpeed);
    mySpeed = null;
    if (msg) showToast(msg, 3500);
    paint();
  }

  async function create() {
    try { start(await req("POST", "/api/rooms")); showToast(`Комната ${code} создана — отправь код друзьям`, 4000, { kind: "ok" }); }
    catch (e) { setStatus(e.message); }
  }
  async function join(c) {
    const norm = String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (norm.length < 4) return setStatus("Введи код комнаты");
    try { start(await req("POST", `/api/rooms/${norm}/join`)); showToast(`Ты в комнате ${norm}`, 3000, { kind: "ok" }); }
    catch (e) { setStatus(e.message); if (!panel) showToast(e.message, 5000); }
  }

  // ---------- приглашение по ссылке ----------
  // Другу отправляется https-ссылка на страницу архива; она открывает whisper://room/КОД, система передаёт ссылку
  // приложению (src-tauri/src/deeplink.rs), а оно — сюда. Вход всегда подтверждается: ссылка ничего не делает молча.
  const INVITE_BASE = "https://origin.whisper-archive.ru/join/";
  const inviteUrl = () => INVITE_BASE + code;
  async function copyInvite() {
    if (!inRoom()) return;
    try { await navigator.clipboard.writeText(inviteUrl()); showToast("Ссылка-приглашение скопирована — отправь её друзьям", 3500, { kind: "ok" }); }
    catch { showToast(inviteUrl(), 8000); }
  }
  let offering = false;
  async function takeLink() {
    let c = null;
    try { c = await invoke("room_link_take"); } catch {}
    if (c) offerJoin(c);
  }
  async function offerJoin(raw) {
    const c = String(raw || "").toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(c) || offering) return;
    if (inRoom() && code === c) { showToast(`Ты уже в комнате ${c}`, 3000, { kind: "ok" }); if (!panel) open(); return; }
    offering = true;
    try {
      let hasKey = false;
      try { hasKey = await invoke("wa_token_exists"); } catch {}
      if (!hasKey) {
        // комнаты работают через Whisper Archive: без входа в архив сначала вход, потом сразу в комнату
        const go = await modal({ title: "Слушать вместе", text: `Тебя пригласили в комнату ${c}. Комнаты работают через Whisper Archive — сначала войди в архив.`, ok: "Войти в архив" });
        const login = W.modules.archive?.login;
        if (!go || typeof login !== "function") return;
        await login("Чтобы войти в комнату по приглашению");
        try { hasKey = await invoke("wa_token_exists"); } catch {}
        if (!hasKey) return;
      } else {
        const text = !inRoom() ? `Тебя пригласили слушать вместе: комната ${c}. Музыкой управляет ведущий, каждый слушает со своего ${account()}.`
          : isHost() ? `Ты ведёшь комнату ${code} — она закроется для всех. Перейти в комнату ${c}?`
          : `Ты сейчас в комнате ${code}. Перейти в комнату ${c}?`;
        const ok = await modal({ title: "Слушать вместе", text, ok: inRoom() ? "Перейти" : "Войти" });
        if (!ok) return;
      }
      if (inRoom()) await leave();
      await join(c);
    } finally { offering = false; }
  }
  // ---------- друзья и приглашения из приложения ----------
  // Друзья — все, с кем ты уже был в одной комнате (сервер запоминает при входе в комнату). Позвать друга — кнопка
  // в окне комнаты (или в окне «Слушать вместе» до комнаты: тогда комната создаётся сама). У друга приложение ждёт
  // приглашений (wa_room_invites — long-poll, пока запущено) и показывает уведомление «Войти»; вход — как по ссылке
  // (offerJoin: окно с подтверждением). Звать можно только друзей, кто тебя удалил из своих — приглашений не получает.
  async function cmd(name, args) {
    const r = await invoke(name, args);
    let data = null;
    try { data = r.body ? JSON.parse(r.body) : null; } catch {}
    if (r.status >= 200 && r.status < 300) return data;
    const e = new Error(data?.message || `Сервер ответил HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  let friends = [], friendsAt = 0, friendsBusy = false, invites = [];
  const invited = new Map();          // id друга → когда позвали (подпись «Позван» на 10 минут)
  const seenInv = new Set();          // приглашения, о которых уже сказали
  async function loadFriends(force = false) {
    if (friendsBusy || (!force && Date.now() - friendsAt < 15000)) return;
    friendsBusy = true;
    try {
      const v = await cmd("wa_room_friends");
      const next = (Array.isArray(v) ? v : []).filter((f) => UUID.test(String(f?.id || "")) && f.nickname).slice(0, 100);
      const changed = JSON.stringify(next) !== JSON.stringify(friends);
      friends = next;
      friendsAt = Date.now();
      if (changed && panel) paint();
      inboxKick();
    } catch {} finally { friendsBusy = false; }
  }
  async function inviteFriend(f) {
    if (!inRoom()) { await create(); if (!inRoom()) return; }
    try {
      const r = await cmd("wa_room_invite", { code, userId: String(f.id) });
      invited.set(String(f.id), Date.now());
      showToast(r?.online ? `${f.nickname} получит приглашение` : `Приглашение отправлено — ${f.nickname} увидит его, когда откроет приложение`, 4000, { kind: "ok" });
    } catch (e) { showToast("Не удалось позвать: " + e.message, 5000, { kind: "err" }); }
    if (panel) paint();
  }
  async function forgetFriend(f) {
    const ok = await modal({ title: "Убрать из друзей?", text: `${f.nickname} пропадёт из списка, и звать друг друга из приложения вы больше не сможете. Снова станете друзьями, если окажетесь в одной комнате.`, ok: "Убрать", danger: true });
    if (!ok) return;
    try { await cmd("wa_room_friend_forget", { id: String(f.id) }); friends = friends.filter((x) => x.id !== f.id); }
    catch (e) { showToast("Не удалось убрать: " + e.message, 4000, { kind: "err" }); }
    if (panel) paint();
  }

  // ждать приглашений — пока запущено приложение и есть хоть один друг (или ты в комнате)
  let inboxOn = false, inboxGen = 0;
  function inboxKick() { if (!inboxOn && (friends.length || inRoom())) { inboxOn = true; inboxLoop(++inboxGen); } }
  async function inboxLoop(gen) {
    let since = null, fails = 0;
    while (gen === inboxGen) {
      const t0 = Date.now();
      try {
        const v = await cmd("wa_room_invites", { since });
        if (gen !== inboxGen) return;
        fails = 0;
        const ver = +v?.version || 0;
        const same = since === ver;
        since = ver;
        const next = (Array.isArray(v?.invites) ? v.invites : []).filter((i) => i?.id && /^[A-Z0-9]{4,12}$/.test(String(i.code || "")));
        const changed = JSON.stringify(next.map((i) => i.id)) !== JSON.stringify(invites.map((i) => i.id));
        invites = next;
        for (const inv of invites) onInvite(inv);
        if (changed && panel) paint();
        if (same && Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 3000));   // сервер не ждал — не крутимся вхолостую
      } catch (e) {
        if (gen !== inboxGen) return;
        // нет входа в архив или старый сервер без приглашений — перестаём (снова — после входа в комнату)
        if ([401, 403, 404, 405].includes(e.status) || /не задан/i.test(e.message)) { inboxOn = false; return; }
        await new Promise((r) => setTimeout(r, Math.min(60000, 3000 * ++fails)));
      }
    }
  }
  function onInvite(inv) {
    if (seenInv.has(inv.id)) return;
    seenInv.add(inv.id);
    if (inRoom() && code === inv.code) return;
    const who = String(inv.from || "Друг").slice(0, 40);
    showToast(`${who} зовёт слушать вместе`, 15000, { action: { label: "Войти", fn: () => offerJoin(inv.code) } });
    // окно свёрнуто или в фоне — мигнуть значком на панели задач
    if (!document.hasFocus()) {
      try { window.__TAURI__?.window?.getCurrentWindow?.().requestUserAttention(2)?.catch?.(() => {}); } catch {}
    }
  }
  async function declineInvite(inv) {
    invites = invites.filter((i) => i.id !== inv.id);
    if (panel) paint();
    try { await cmd("wa_room_invite_dismiss", { id: String(inv.id) }); } catch {}
  }
  // при запуске: есть вход в архив — узнать друзей (и, если они есть, ждать приглашений)
  setTimeout(async () => {
    let hasKey = false;
    try { hasKey = await invoke("wa_token_exists"); } catch {}
    if (hasKey) loadFriends(true);
  }, 2500);

  window.__TAURI__.event?.listen("room-link", () => takeLink());
  setTimeout(takeLink, 1200);        // приложение запустили по ссылке — окно и вход к этому времени готовы
  async function leave() {
    const c = code;
    gone(isHost() ? "Комната закрыта" : "Ты вышел из комнаты");
    req("POST", `/api/rooms/${c}/leave`).catch(() => {});
  }
  async function suggest(t) {
    if (!inRoom()) return;
    try { await req("POST", `/api/rooms/${code}/suggest`, toRoomTrack(t)); showToast("Трек предложен ведущему", 2500, { kind: "ok" }); }
    catch (e) { showToast(e.message, 3500); }
  }
  async function dismiss(id) {
    try { await req("POST", `/api/rooms/${code}/suggestions/${id}/dismiss`); } catch {}
  }

  // ---------- кнопки плеера у гостя ----------
  // «Вперёд», «назад», перемотка и режимы у гостя не работают: музыкой управляет ведущий
  // какие кнопки — по ролям интерфейса: в любом приложении это его «вперёд», «назад», повтор и перемешивание
  const guestBlocked = () => inRoom() && !isHost();
  const BLOCKED = ["player.next", "player.prev", "fullplayer.next", "fullplayer.prev", "player.mode"];
  document.addEventListener("click", (e) => {
    if (!guestBlocked()) return;
    const sel = BLOCKED.map((r) => W.ui.selector(r)).filter(Boolean).join(", ");
    if (sel && e.target.closest?.(sel)) {
      e.stopImmediatePropagation(); e.preventDefault();
      showToast("Музыкой в комнате управляет ведущий — предложи трек через «⋯»", 3000);
    }
  }, true);
  for (const el of [...W.ui.all("player.seek"), ...W.ui.all("fullplayer.seek")]) {
    el.addEventListener("input", (e) => { if (guestBlocked() && follow) { e.stopImmediatePropagation(); guestApply(); } }, true);
  }
  // гость перемотал не ползунком (горячие клавиши, стрелки) — сразу обратно к ведущему; свои перемотки синхронизации не в счёт
  W.on("seek", () => { if (guestBlocked() && follow && !syncing) setTimeout(guestApply, 50); });

  // ---------- события плеера ----------
  // от ядра Whisper: смена трека, пауза/воспроизведение, перемотка, скорость, режимы (Whisper.player.watch)
  P.watch((force) => {
    if (!inRoom()) return;
    if (isHost()) return hostPush(force);
    // гость: сам включил другой трек или поставил паузу
    const t = curTrack(), pb = room.playback;
    if (!follow || syncing || !pb) return;
    // трек комнаты ещё выясняется (старый трек пока на месте) — это не уход
    if (!guestFor || guestFor.key !== pbKey(pb.track)) return;
    const md = P.media();
    // трека комнаты у гостя нет, плеер ждёт на паузе; сам включил что-то — отходит, чтобы ожидание это не глушило
    if (guestFor.missing) { if (!md.paused && !md.loading) detach("Ты включил своё"); return; }
    if (t && String(t.id) !== guestWantId(pb)) detach("Ты включил свой трек");
    // трек комнаты ещё грузится (плеер пока на паузе) — это не пауза гостя
    else if (md.paused && pb.playing && !md.pending && !md.loading) {
      // трек просто доиграл раньше, чем пришёл следующий от ведущего, — это не пауза
      const nearEnd = md.ended || (md.duration > 0 && md.duration - P.state().position < 2);
      if (!nearEnd) detach("Пауза у тебя");
    }
  });

  // пункт меню трека «⋯»: гость — предложить, ведущий — ничего (он и так управляет)
  // Отдельный блок в самом верху меню (slot "top"), только когда ты в комнате гостем.
  W.ui.trackMenu.add({
    id: "together", slot: "top",
    build(t, m) {
      if (!inRoom() || isHost()) return false;
      const box = el("div", "mroom" + (follow ? "" : " away"));
      const head = el("div", "mroomhead");
      head.append(el("i", "mroomdot"), el("span", "", `Слушать вместе · ${code}`));
      box.append(head);
      m.item(ROOM_ICON, "Предложить в комнату", () => suggest(t), { to: box });
      if (!follow) m.item(REJOIN_ICON, "Вернуться в комнату", rejoin, { to: box });
      m.append(box);
      return true;
    },
  });

  // ---------- пинг участников (только в комнате) ----------
  // Пинг — время ответа сервера комнат этому клиенту (Rust: wa_room_ping, лучший из трёх запросов). Свой пинг клиент
  // отправляет серверу (POST /api/rooms/{code}/ping {pingMs}), сервер отдаёт его в members[].pingMs (+ pingAt) — так видно
  // и чужой. Сервер без /ping (404/405) — показываем только свой. До 100 мс — норма, 100–199 — жёлтый, от 200 — красный.
  // Показывается по кнопке (окно комнаты, клик по ярлыку пинга) и сам, если трек у этого клиента долго грузится.
  const PING_WARN = 100, PING_BAD = 200, PING_STALE = 120000;
  const pingLevel = (ms) => !(ms > 0) ? "" : ms >= PING_BAD ? "bad" : ms >= PING_WARN ? "warn" : "ok";
  let myPing = 0;                 // свой пинг, мс (0 — ещё не мерили)
  let pingBusy = false;
  let pingSrv = null;             // сервер раздаёт пинг участников: null — неизвестно, true / false
  let pingShowUntil = 0;          // до какого момента пинг виден в плеере
  let pingHideTimer = 0;
  let pingErr = "";
  const memberPing = (m) => {
    if (m?.isMe) return myPing;
    const ms = +(m?.pingMs ?? m?.ping ?? 0);
    if (!(ms > 0)) return 0;
    if (m.pingAt && nowSrv() - +m.pingAt > PING_STALE) return 0;      // давно не обновлялся — не показываем
    return ms;
  };
  const pingShown = () => inRoom() && (pingBusy && pingShowUntil > 0 || Date.now() < pingShowUntil);
  const pingProblems = () => (room?.members || []).filter((m) => !m.isMe && pingLevel(memberPing(m)) && pingLevel(memberPing(m)) !== "ok");

  // show — вывести результат в плеер; без него только замер и отправка серверу (фоновое обновление для остальных)
  async function checkPing(show = true) {
    if (!inRoom() || pingBusy) return;
    pingBusy = true; pingErr = "";
    const c = code;
    if (show) { clearTimeout(pingHideTimer); pingShowUntil = Date.now() + 60000; paintPing(); }
    try {
      const r = await invoke("wa_room_ping", { code: c, report: pingSrv !== false });
      if (c !== code) return;
      if (r.status === 404) return gone("Комната закрыта");
      if (r.ms > 0) myPing = r.ms;
      const rp = r.report;
      if (rp) {
        if ([404, 405, 501].includes(rp.status)) pingSrv = false;
        else if (rp.status >= 200 && rp.status < 300) {
          pingSrv = true;
          // сервер вернул участников — сразу берём их пинг, не дожидаясь следующего снимка
          try { const s = JSON.parse(rp.body || "null"); if (room && Array.isArray(s?.members)) room.members = s.members; } catch {}
        }
      }
    } catch (e) {
      pingErr = String(e?.message || e || "нет связи");
    } finally {
      pingBusy = false;
      if (show) {
        // есть проблемы — дольше на экране, всё в порядке — ненадолго
        const bad = pingLevel(myPing) !== "ok" || pingProblems().length > 0;
        pingShowUntil = Date.now() + (bad ? 30000 : 12000);
        clearTimeout(pingHideTimer);
        pingHideTimer = setTimeout(paintPing, pingShowUntil - Date.now() + 50);
      }
      paintPing();
      if (panel) paint();
    }
  }
  // фон: свой пинг серверу раз в 30 с — чтобы у остальных он был свежим, когда они проверят
  // (и в свёрнутом окне: музыку часто слушают свернув, а пинг такого участника тоже нужен остальным)
  setInterval(() => { if (inRoom() && pingSrv !== false) checkPing(false); }, 30000);
  // трек у этого клиента грузится дольше 3 с — проверить и показать пинг (один раз на трек)
  let loadSince = 0, loadKey = "", loadChecked = "";
  setInterval(() => {
    if (!inRoom()) { loadSince = 0; return; }
    const md = P.media(), t = curTrack();
    if (!md.loading || !t) { loadSince = 0; return; }
    const key = String(t.id);
    if (key !== loadKey || !loadSince) { loadKey = key; loadSince = Date.now(); }
    if (Date.now() - loadSince > 3000 && loadChecked !== key) { loadChecked = key; checkPing(true); }
  }, 500);

  // строка пинга в плеере: рядом с ярлыком комнаты, в потоке — ничего не перекрывает
  let pingEl = null;
  function paintPing() {
    if (!pingEl) {
      pingEl = el("div", "roompings");
      pingEl.setAttribute("role", "button"); pingEl.tabIndex = 0;
      pingEl.title = "Пинг до сервера комнат — нажми, чтобы проверить ещё раз";
      const again = (e) => { e?.preventDefault(); e?.stopPropagation(); checkPing(true); };
      pingEl.addEventListener("click", again);
      pingEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") again(e); });
    }
    const line = tab?.parentNode;
    if (!pingShown() || !line) { pingEl.remove(); return; }
    if (pingEl.parentNode !== line) line.append(pingEl);
    pingEl.textContent = "";
    pingEl.classList.toggle("busy", pingBusy);
    const chip = (name, ms) => {
      const lv = pingLevel(ms);
      const c = el("span", "rpchip " + (lv || "none"));
      c.append(el("i", "rpdot"), el("span", "rpname", name), el("b", "", ms > 0 ? `${ms} мс` : "—"));
      return c;
    };
    if (pingBusy && !myPing) { pingEl.append(el("span", "rpchip none", "пинг…")); return; }
    if (pingErr && !myPing) { pingEl.append(el("span", "rpchip bad", "нет связи")); return; }
    pingEl.append(chip("ты", myPing));
    // чужой пинг — только жёлтый и красный, чтобы строка не разрасталась; у остальных всё в порядке — «✓»
    const others = (room.members || []).filter((m) => !m.isMe);
    const probs = pingProblems().sort((a, b) => memberPing(b) - memberPing(a));
    for (const m of probs.slice(0, 3)) pingEl.append(chip(String(m.nickname || "Гость"), memberPing(m)));
    if (probs.length > 3) pingEl.append(el("span", "rpchip more", `+${probs.length - 3}`));
    if (!probs.length && others.some((m) => memberPing(m) > 0)) pingEl.append(el("span", "rpchip ok rpall", "у остальных ✓"));
    if (pingSrv === false && others.length) pingEl.title = "Свой пинг. Пинг остальных сервер комнат пока не передаёт";
    else pingEl.title = "Пинг до сервера комнат — нажми, чтобы проверить ещё раз";
  }
  // значок пинга у участника в окне комнаты
  function pingBadge(m) {
    const ms = memberPing(m);
    if (!(ms > 0)) return null;
    const b = el("span", "rmping " + pingLevel(ms), `${ms} мс`);
    b.title = "Пинг до сервера комнат";
    return b;
  }

  // ---------- окно «Слушать вместе» ----------
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function setStatus(t) { const s = panel && $t(".rmstatus", panel.box); if (s) s.textContent = t || ""; }

  function open() {
    if (panel) return close();
    const wrap = el("div", "login modal");
    // слева от окна — отдельный модуль «Участники» (виден только в комнате), справа — само окно
    const stage = el("div", "rmstage");
    const side = el("aside", "panel login-box rmside"); side.hidden = true;
    const box = el("div", "panel login-box modalbox rmbox");
    stage.append(side, box); wrap.append(stage); document.body.append(wrap);
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("keydown", onKey, true);
    wrap.onpointerdown = (e) => { if (e.target === wrap || e.target === stage) close(); };
    panel = { wrap, box, side, onKey };
    paint();
  }
  function close() {
    if (!panel) return;
    document.removeEventListener("keydown", panel.onKey, true);
    panel.wrap.remove(); panel = null;
  }

  // окно перерисовывается и пока идёт проверка ключа (пришли друзья, приглашение) — дорисовывает только последний вызов,
  // иначе содержимое удваивалось бы
  let setupGen = 0;
  async function paintSetup(box) {
    const g = ++setupGen;
    let hasKey = false;
    try { hasKey = await invoke("wa_token_exists"); } catch {}
    if (!panel || panel.box !== box || g !== setupGen || inRoom()) return;
    box.textContent = "";
    box.append(el("h2", "", "Слушать вместе"));
    box.append(el("p", "rmlead", `Одна и та же музыка у всех в комнате в один и тот же момент. Каждый слушает со своего ${account()}, ведущий управляет, остальные могут предлагать треки.`));
    if (!hasKey) {
      box.append(el("p", "rmwarn", "Комнаты работают через Whisper Archive. Войди в архив: Настройки → «Для разработчиков» → Whisper Archive — у всех участников."));
    }
    const mk = el("button", "nav active rmcreate", "Создать комнату");
    mk.type = "button"; mk.disabled = !hasKey; mk.onclick = create;
    const row = el("form", "rmjoin");
    const inp = el("input", "field rmcode"); inp.placeholder = "Код комнаты"; inp.maxLength = 12; inp.autocomplete = "off"; inp.spellcheck = false;
    inp.oninput = () => { inp.value = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); };
    const go = el("button", "nav", "Войти"); go.type = "submit"; go.disabled = !hasKey;
    row.onsubmit = (e) => { e.preventDefault(); join(inp.value); };
    row.append(inp, go);
    box.append(mk, el("div", "rmor", "или"), row);
    if (hasKey) { invitesBlock(box); friendsBlock(box); loadFriends(); }
    box.append(el("p", "status rmstatus"));
    const done = el("button", "nav", "Закрыть"); done.type = "button"; done.onclick = close;
    const r = el("div", "row"); r.append(done); box.append(r);
    if (hasKey) inp.focus();
  }

  // «Позвать друзей»: друзья, которых сейчас нет в комнате; без комнаты «Позвать» сначала создаёт её
  function friendsBlock(box) {
    const here = new Set((room?.members || []).map((m) => String(memberId(m) ?? "")));
    const list = friends.filter((f) => !here.has(String(f.id)));
    if (!list.length) return;
    const sec = el("div", "rmfriends");
    sec.append(el("small", "", inRoom() ? "Позвать друзей" : "Друзья — с ними ты уже слушал вместе"));
    const ul = el("div", "rmflist");
    // сначала те, у кого приложение открыто
    for (const f of [...list].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0))) {
      const row = el("div", "rmfriend");
      const dot = el("i", "rmfdot" + (f.online ? " on" : ""));
      dot.title = f.online ? "Приложение открыто" : "Не в сети";
      const name = el("span", "rmfname", f.nickname);
      name.title = `Слушали вместе: ${f.metCount || 1} ${(f.metCount || 1) % 10 >= 2 && (f.metCount || 1) % 10 <= 4 && ((f.metCount || 1) % 100 < 10 || (f.metCount || 1) % 100 > 20) ? "раза" : "раз"}`;
      const was = invited.get(String(f.id));
      const fresh = was && Date.now() - was < 10 * 60e3;
      const b = el("button", "nav" + (fresh ? "" : " active"), fresh ? "Позван ✓" : "Позвать");
      b.type = "button";
      b.title = fresh ? "Позвать ещё раз" : inRoom() ? "Друг получит уведомление в приложении" : "Создать комнату и позвать";
      b.onclick = () => { b.disabled = true; inviteFriend(f).finally(() => { b.disabled = false; }); };
      const x = el("button", "rmact", "✕"); x.type = "button"; x.title = "Убрать из друзей"; x.onclick = () => forgetFriend(f);
      row.append(dot, name, b, x);
      ul.append(row);
    }
    sec.append(ul);
    box.append(sec);
  }
  // приглашения тебе (окно до комнаты): «Войти» — как по ссылке, «✕» — отклонить
  function invitesBlock(box) {
    const list = invites.filter((i) => !(inRoom() && code === i.code));
    if (!list.length) return;
    const sec = el("div", "rmfriends rminvites");
    sec.append(el("small", "", "Тебя зовут"));
    for (const inv of list) {
      const row = el("div", "rmfriend");
      row.append(el("i", "rmfdot on"), el("span", "rmfname", `${String(inv.from || "Друг").slice(0, 40)} · ${inv.code}`));
      const b = el("button", "nav active", "Войти"); b.type = "button"; b.onclick = () => offerJoin(inv.code);
      const x = el("button", "rmact", "✕"); x.type = "button"; x.title = "Отклонить"; x.onclick = () => declineInvite(inv);
      row.append(b, x);
      sec.append(row);
    }
    box.append(sec);
  }

  function trackLine(t) {
    const d = el("div", "rmtrack");
    const img = el("img"); img.alt = ""; const src = W.cover(roomEntity(t), 100); if (src) img.src = src;
    const tx = el("div", "rmtx");
    tx.append(el("b", "", t.title), el("span", "", (t.artists || []).map((a) => a.name).join(", ")));
    d.append(img, tx);
    return d;
  }

  function paintRoom(box) {
    const h = el("div", "rmhead");
    h.append(el("h2", "", "Слушать вместе"), el("span", "rmrole", isHost() ? "ты ведущий" : "ты гость"));
    box.append(h);
    // код
    const c = el("div", "rmcodebox");
    const big = el("b", "rmbig", code);
    const cp = el("button", "nav", "Копировать код"); cp.type = "button";
    cp.onclick = async () => { try { await navigator.clipboard.writeText(code); showToast("Код скопирован", 2000, { kind: "ok" }); } catch {} };
    const lk = el("button", "nav active", "Ссылка-приглашение"); lk.type = "button";
    lk.title = inviteUrl() + " — друг откроет её, и приложение предложит войти в комнату";
    lk.onclick = copyInvite;
    const btns = el("div", "rmcodebtns"); btns.append(lk, cp);
    c.append(el("span", "", "Код комнаты"), big, btns);
    box.append(c);
    friendsBlock(box);
    // пинг: свой + кнопка проверки (пинг каждого — в списке участников слева)
    const pr = el("div", "rmpingrow");
    const plv = pingLevel(myPing);
    const val = el("b", "rmping " + (plv || "none"), pingBusy ? "проверка…" : myPing > 0 ? `${myPing} мс` : pingErr ? "нет связи" : "не проверен");
    const lab = el("span", "", "Твой пинг");
    lab.title = `До ${PING_WARN} мс — норма, ${PING_WARN}–${PING_BAD - 1} — средний, от ${PING_BAD} — высокий` + (pingSrv === false ? ". Пинг остальных сервер комнат пока не передаёт" : "");
    const chk = el("button", "nav", "Проверить пинг"); chk.type = "button"; chk.disabled = pingBusy;
    chk.onclick = () => checkPing(true);
    pr.append(lab, val, chk);
    box.append(pr);
    // что играет
    const pb = room.playback;
    if (pb) {
      const np = el("div", "rmnow");
      np.append(el("small", "", pb.playing ? "Сейчас играет" : "На паузе"), trackLine(pb.track));
      box.append(np);
    }
    if (!isHost()) {
      const st = el("div", "rmsync" + (follow ? " on" : ""));
      st.append(el("span", "", follow ? "Синхронно с ведущим" : "Ты слушаешь своё"));
      if (!follow) { const b = el("button", "nav active", "Вернуться в комнату"); b.type = "button"; b.onclick = rejoin; st.append(b); }
      box.append(st);
    }
    // участники — в отдельном модуле слева от окна (paintSide)
    // ведущий: предложения сами встают в очередь
    if (isHost()) {
      const lb = el("label", "switch rmauto");
      lb.title = "Предложенные треки играют по очереди после текущего. Когда они кончатся — продолжится то, что играло, а в конце очереди включится Моя волна";
      const cb = el("input"); cb.type = "checkbox"; cb.checked = autoQ; cb.onchange = () => setAutoQ(cb.checked);
      lb.append(cb, el("i"), el("span", "", "Ставить в очередь"));
      box.append(lb);
      // ведущий: трека нет у гостя — передать ему файл через архив (на время комнаты или с сохранением себе)
      const can = canShare();
      const ls = el("label", "switch rmauto");
      ls.title = can
        ? "Если у гостя трека нет на его площадке, файл передаётся ему через сервер Whisper Archive. Он хранится, только пока открыта комната"
        : "Нужен вход в Whisper Archive";
      const cs = el("input"); cs.type = "checkbox"; cs.checked = shareOn && can; cs.disabled = !can; cs.onchange = () => setShareOn(cs.checked);
      ls.append(cs, el("i"), el("span", "", "Делиться треками, которых нет у гостей"));
      box.append(ls);
      if (shareOn && can && canSave() && canCache()) {
        const lv2 = el("label", "switch rmauto rmsub");
        lv2.title = "Переданные треки остаются у тебя в приватном альбоме «Слушать вместе»";
        const c2 = el("input"); c2.type = "checkbox"; c2.checked = shareSave; c2.onchange = () => setShareSave(c2.checked);
        lv2.append(c2, el("i"), el("span", "", "Сохранять их в мой архив"));
        box.append(lv2);
      }
      const ms = room.missing;
      if (ms?.members?.length) {
        const cur = String(curTrack()?.id ?? ""), who = ms.members.join(", ");
        box.append(el("p", "rmwarn", roomShared.has(cur) ? `Через архив слушают: ${who}`
          : `Нет на площадке у: ${who}` + (shareBusy === cur ? " — трек передаётся…" : "")));
      }
    } else if (guestFor?.missing && room.playback && guestFor.key === pbKey(room.playback.track)) {
      box.append(el("p", "rmwarn", "Этого трека нет на твоей площадке. Он заиграет, если ведущий поделится им через архив."));
    }
    // предложения
    const sg = room.suggestions || [];
    const sb = el("div", "rmsugs");
    sb.append(el("small", "", isHost() ? (sg.length ? "Предлагают" : "Предложений пока нет — гости предлагают треки через «⋯»") : (sg.length ? "Твои предложения" : "Предложить трек: «⋯» у трека → «Предложить в комнату»")));
    for (const s of sg) {
      const row = el("div", "rmsug" + (taken.has(s.id) ? " taken" : ""));
      row.append(trackLine(s.track));
      if (isHost()) row.append(el("span", "rmfrom", taken.has(s.id) ? "в очереди" : s.from));
      const acts = el("div", "rmacts");
      const btn = (label, title, fn) => { const b = el("button", "rmact", label); b.type = "button"; b.title = title; b.onclick = fn; acts.append(b); };
      const ent = isHost() ? sugEntity(s) : null;
      if (isHost() && !taken.has(s.id) && ent) {
        btn("▶", "Включить сейчас", () => { taken.add(s.id); P.playTrack(ent, { context: "room" }); dismiss(s.id); });
        btn("＋", "Играть следующим", () => queueSug(s));
      } else if (isHost() && !taken.has(s.id)) row.append(el("span", "rmfrom", "нет на твоей площадке"));
      btn("✕", isHost() ? "Убрать" : "Отозвать", () => dismiss(s.id));
      row.append(acts); sb.append(row);
    }
    box.append(sb, el("p", "status rmstatus"));
    const r = el("div", "row");
    const lv = el("button", "nav danger", isHost() ? "Закрыть комнату" : "Выйти"); lv.type = "button"; lv.onclick = () => { leave(); };
    const done = el("button", "nav active", "Готово"); done.type = "button"; done.onclick = close;
    r.append(lv, done); box.append(r);
  }

  // ---------- модуль «Участники» слева от окна ----------
  // Ведущий (с короной) всегда первый, дальше — слушатели в порядке входа. Сменился ведущий — список перестраивается,
  // строки плавно переезжают на новые места (FLIP: запоминаем старые позиции до перерисовки и анимируем сдвиг).
  const CROWN = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M3 8.5l4.6 3.8L12 5l4.4 7.3L21 8.5 19.2 18H4.8L3 8.5z" fill="currentColor"/><path d="M5 20.2h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const memberKey = (m) => String(memberId(m) ?? m.nickname ?? "");
  const sortedMembers = () => (room?.members || []).map((m, i) => ({ m, i }))
    .sort((a, b) => (b.m.isHost ? 1 : 0) - (a.m.isHost ? 1 : 0) || a.i - b.i).map((x) => x.m);
  const animOff = () => document.documentElement.dataset.anim === "off" || document.body.classList.contains("reduce-motion")
    || matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  function personRow(m) {
    const id = memberId(m);
    const canPick = isHost() && !m.isMe && !m.isHost && id != null;      // ведущий: нажать — передать управление
    const sel = canPick && confirmFor === String(id);
    const row = el(canPick ? "button" : "div", "rmperson" + (m.isHost ? " host" : "") + (m.isMe ? " me" : "") + (canPick ? " pick" : "") + (sel ? " sel" : ""));
    row.dataset.key = memberKey(m);
    if (canPick) {
      row.type = "button"; row.title = "Сделать ведущим";
      row.onclick = () => { confirmFor = sel ? null : String(id); paint(); };
    }
    const name = String(m.nickname || "Гость");
    const av = el("span", "rmava", name.trim().charAt(0).toUpperCase() || "?");
    if (m.isHost) av.insertAdjacentHTML("beforeend", `<i class="rmcrown" title="Ведущий">${CROWN}</i>`);
    const tx = el("span", "rmpname");
    tx.append(el("b", "", name), el("small", "", m.isHost ? (m.isMe ? "ведущий · это ты" : "ведущий · управляет музыкой") : (m.isMe ? "это ты" : "слушает")));
    row.append(av, tx);
    const pb = pingBadge(m);
    if (pb) row.append(pb);
    return { row, target: sel ? m : null };
  }

  function paintSide(side) {
    const before = new Map();
    for (const r of side.querySelectorAll(".rmperson[data-key]")) before.set(r.dataset.key, r.getBoundingClientRect().top);
    side.textContent = "";
    const list = sortedMembers();
    const host = list.find((m) => m.isHost), rest = list.filter((m) => !m.isHost);
    const head = el("div", "rmsidehead");
    head.append(el("b", "", "Участники"), el("span", "rmcount", String(list.length)));
    side.append(head);
    const ul = el("div", "rmpeople");
    let target = null;
    if (host) {
      ul.append(el("small", "rmgroup", "Ведущий"));
      ul.append(personRow(host).row);
    }
    ul.append(el("small", "rmgroup", rest.length ? `Слушатели · ${rest.length}` : "Слушателей пока нет"));
    for (const m of rest) { const p = personRow(m); ul.append(p.row); if (p.target) target = p.target; }
    if (!rest.length) ul.append(el("p", "rmempty", "Отправь друзьям код или ссылку-приглашение — они появятся здесь."));
    side.append(ul);
    if (isHost() && !target && rest.some((m) => !m.isMe && memberId(m) != null)) side.append(el("small", "rmhint", "Нажми на слушателя, чтобы передать ему корону — управление музыкой"));
    if (!isHost()) side.append(el("small", "rmhint", "Музыкой управляет ведущий с короной. Предложить трек — «⋯» у трека"));
    if (target) {
      const cf = el("div", "rmconfirm");
      cf.append(el("span", "", `Передать управление ${target.nickname}? Комната и код останутся, ты станешь слушателем.`));
      const yes = el("button", "nav active", "Передать"); yes.type = "button"; yes.onclick = () => transfer(target);
      const no = el("button", "nav", "Отмена"); no.type = "button"; no.onclick = () => { confirmFor = null; paint(); };
      const r2 = el("div", "rmconfirmbtns"); r2.append(no, yes); cf.append(r2);
      side.append(cf);
    }
    // перестроение: строки переезжают со старых мест на новые
    if (!before.size || animOff()) return;
    for (const r of side.querySelectorAll(".rmperson[data-key]")) {
      const was = before.get(r.dataset.key);
      if (was == null) { r.animate?.([{ opacity: 0, transform: "translateX(-8px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "ease-out" }); continue; }
      const dy = was - r.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) r.animate?.([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 380, easing: "cubic-bezier(.2,.75,.2,1)" });
    }
  }

  // ---------- режим комнаты: ярлык под названием трека в плеере ----------
  // Ведущий: «◆ Ты ведущий · КОД». Гость: «● Ты гость · КОД». Гость отошёл: заливная светящаяся
  // «Вернуться в комнату» — её видно с любой страницы, и она возвращает в один клик.
  const ROOM_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 19c.6-3.3 3-5 6-5s5.4 1.7 6 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M17 8v6M14 11h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const REJOIN_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // Ярлык — не <button>: на кнопки внутри .player действует «.player button { 38×38, круг }», из-за чего
  // ярлык сжимался в кружок и клик по нему не срабатывал. Живёт в потоке под названием трека — ничего не перекрывает.
  let tab = null;
  let tabLine = null;             // строка под названием трека: ярлык комнаты + пинг (paintPing)
  function tabClick(e) {
    e?.preventDefault(); e?.stopPropagation();
    if (!inRoom()) return;
    if (!isHost() && !follow) rejoin(); else if (!panel) open();
  }
  function paintTab() {
    const meta = roleEl("player.info");                // под названием и исполнителем в плеере
    if (!inRoom()) { tabLine?.remove(); tabLine = null; tab = null; document.body.classList.remove("room-away"); paintPing(); return; }
    if (!tab && meta) {
      tabLine = el("div", "roomline");
      tab = el("div", "roomtab");
      tab.setAttribute("role", "button"); tab.tabIndex = 0;
      tab.addEventListener("click", tabClick);
      tab.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") tabClick(e); });
      tabLine.append(tab);
    }
    if (tabLine && meta && tabLine.parentNode !== meta) meta.append(tabLine);
    const away = !isHost() && !follow;
    document.body.classList.toggle("room-away", away);
    if (!tab) return;
    paintPing();
    tab.className = "roomtab" + (isHost() ? " host" : away ? " away" : " guest");
    tab.textContent = "";
    if (away) {
      tab.insertAdjacentHTML("beforeend", REJOIN_ICON);
      tab.append(el("b", "", "Вернуться в комнату"), el("span", "rtsub", `· ${code}`));
      tab.title = "Снова слушать то же, что ведущий";
    } else {
      tab.append(el("i", "rtdot"), el("span", "", (isHost() ? "Ты ведущий" : "Ты гость") + ` · ${code} · ${room.members.length}`));
      tab.title = "Открыть окно «Слушать вместе»";
    }
  }

  function paint() {
    keep();                          // код, роль и «следует за ведущим» — на случай перезагрузки окна
    // кнопка в плеере: подсвечена в комнате, на ней — сколько слушают
    const b = btn;
    if (b) {
      b.classList.toggle("on", inRoom());
      b.classList.toggle("detached", inRoom() && !isHost() && !follow);
      b.dataset.n = inRoom() ? String(room.members.length) : "";
      const waiting = inRoom() && isHost() ? sugList().filter((s) => !taken.has(s.id)).length : 0;
      b.classList.toggle("sug", waiting > 0);
      b.title = inRoom() ? `Слушать вместе · комната ${code} · ${room.members.length} чел.` + (waiting ? ` · предложений: ${waiting}` : "") : "Слушать вместе";
    }
    paintTab();
    W.emit("room", roomEvent());     // приложению: у Whisper Yandex — страница «Моя волна» у гостя (yandex.js)
    if (!panel) return;
    const keepStatus = $t(".rmstatus", panel.box)?.textContent || "";
    // набранный код комнаты не должен пропадать, если окно перерисовалось (пришли друзья или приглашение)
    const codeInp = $t(".rmcode", panel.box), keepCode = codeInp?.value || "", codeFocus = codeInp && document.activeElement === codeInp;
    panel.box.textContent = "";
    if (inRoom()) paintRoom(panel.box);
    else paintSetup(panel.box).then(() => {
      const ni = panel && $t(".rmcode", panel.box);
      if (ni && keepCode) { ni.value = keepCode; if (codeFocus) ni.focus(); }
    });
    if (keepStatus) setStatus(keepStatus);
    panel.side.hidden = !inRoom();
    if (inRoom()) paintSide(panel.side); else panel.side.textContent = "";
  }

  // кнопка — та, что приложение уже поставило в разметку (#togetherBtn), иначе своя в начале правого блока плеера
  let btn = document.getElementById("togetherBtn");
  if (!btn) {
    btn = el("button", "togetherbtn"); btn.id = "togetherBtn"; btn.title = "Слушать вместе";
    (roleEl("player.actions") || roleEl("player"))?.prepend(btn);
    if (!btn.isConnected) btn = null;
  }
  if (btn) {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 19c.6-3.3 3-5 6-5s5.4 1.7 6 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M15.5 5.3a3 3 0 0 1 0 5.4M18 13.6c1.6.7 2.7 2.4 3 5.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    btn.onclick = open;
  }
  // Окно перезагружается (или закрывается) — из комнаты НЕ выходим: раньше здесь уходил leave, и после F5 ведущий
  // закрывал комнату для всех, а гость из неё выпадал. Код запоминаем — после перезагрузки restore() вернёт в комнату.
  // Если приложение закрыли совсем, сервер сам уберёт участника по тишине.
  window.addEventListener("beforeunload", keep);

  // ---------- возврат в комнату после перезагрузки окна ----------
  async function restore() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(KEEP_KEY) || "null"); } catch {}
    if (!saved || inRoom()) return;
    const c = String(saved.code || "").toUpperCase();
    // ведущего сервер держит 120 с, гостя — 75 с: позже комнаты (или места в ней) уже нет
    if (!/^[A-Z0-9]{4,12}$/.test(c) || !(Date.now() - (+saved.at || 0) < 10 * 60 * 1000)) return unkeep();
    let snap = null;
    try { snap = await req("GET", `/api/rooms/${c}`, null, null); }
    catch (e) {
      if (e.status === 404) { unkeep(); return showToast(`Комната ${c} уже закрыта`, 3500); }
      // 403 — сервер успел убрать нас из участников: просто входим снова
      try { snap = await req("POST", `/api/rooms/${c}/join`); }
      catch (e2) { if (e2.status === 404) unkeep(); return showToast(`Не удалось вернуться в комнату ${c}: ${e2.message}`, 5000); }
    }
    if (!snap?.code || snap.closed || inRoom()) return;
    if (!snap.isHost && saved.follow === false) follow = false;
    const pb = snap.playback;
    if (snap.isHost && pb?.track) {
      // ведущий: продолжаем то, что слушала комната, с нужного места; пока не заиграет — гостям ничего не шлём
      offset = (snap.serverNow || Date.now()) - Date.now();
      const at = Math.max(0, (pb.positionMs + (pb.playing ? (nowSrv() - pb.at) * (pb.rate || 1) : 0)) / 1000);
      if (pb.playing) resumeUntil = Date.now() + 15000;
      const t = curTrack(), md = P.media();
      try {
        if (t && t.id === String(pb.track.id) && md.pending) await P.reload(at, !pb.playing);
        else if (!t || t.id !== String(pb.track.id) || md.pending) await P.playTrack(roomEntity(pb.track), { at, hold: !pb.playing, context: "room" });
      } catch { resumeUntil = 0; }
    }
    start(snap, true);
    showToast(snap.isHost ? `Комната ${c} снова с тобой — ты ведущий` : `Ты снова в комнате ${c}`, 3000, { kind: "ok" });
  }
  // ждём, пока приложение поднимет плеер (после перезагрузки в нём снова появляется последний трек), но не дольше 6 с
  (async () => {
    try { if (!sessionStorage.getItem(KEEP_KEY)) return; } catch { return; }
    for (let i = 0; i < 30 && !curTrack(); i++) await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, 300));
    restore().catch(() => {});
  })();
  function info() { return inRoom() ? { code, host: isHost(), follow } : null; }
  // событие «room»: { inRoom, code, host, follow, roleChanged? } — всегда объект, и в комнате, и без неё
  function roomEvent() { return { inRoom: inRoom(), code: code || null, host: isHost(), follow, ...(info() || {}) }; }
  const api = {
    info,                                  // { code, host, follow } | null
    wantsPlay,                             // плеер: держать ли трек, загруженный без звука
    take,                                  // плеер: перед следующим треком — поставить предложение («Ставить в очередь»)
    open, create, join, leave, suggest, rejoin,
    ping: () => checkPing(true),           // проверить пинг и показать его в плеере (только в комнате)
    room: () => (inRoom() ? room : null),
    // кнопки бесконечного потока у гостя (у Whisper Yandex — страница «Моя волна»): центральная — играть/пауза
    // трека комнаты, кнопка станций — окно комнаты
    waveBtn: () => {
      if (!inRoom() || isHost()) return;
      if (!follow) return rejoin();
      if (!curTrack() || P.media().pending) return guestApply();
      P.toggle();
    },
    stBtn: () => { if (!inRoom() || isHost()) return; if (!follow) rejoin(); else if (!panel) open(); },
  };
  W.modules.together = api;
  // старые имена: main.js (страница «Моя волна», nextIndex, play) и консоль (cli.js)
  window.roomInfo = info;
  window.roomWantsPlay = wantsPlay;
  window.roomTake = take;
  window.roomCli = { create, join, leave, suggest, info: api.room, waveBtn: api.waveBtn, stBtn: api.stBtn };
})();
