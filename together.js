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
  const ROOM_RE = /^\/api\/rooms(?:\/([A-Z0-9]{4,12})(?:\/(join|leave|state|suggest|host)|\/suggestions\/([A-Za-z0-9]{1,32})\/dismiss)?)?$/;
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
  const toRoomTrack = (t) => {
    const e = W.to("track", t), p = W.provider();
    if (p?.toRoom) return p.toRoom(e);
    return { id: e.id, albumId: e.album?.id || null, title: (e.title || "Без названия").slice(0, 300), version: e.version || null,
      artists: e.artists.slice(0, 10).map((a) => ({ id: a.id || null, name: a.name })), coverUri: null, durationMs: Math.round(e.durationMs) };
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
    try { const id = a.lookup(t)?.id; return UUID.test(String(id || "")) ? String(id) : null; } catch { return null; }
  };
  const curTrack = () => P.state().track;
  const account = () => W.provider()?.accountLabel || "аккаунта";

  // ---------- ведущий: что играет → на сервер ----------
  // Пока у ведущего грузится новый трек (Whisper.player.media().loading), у плеера ещё позиция прошлого трека. Раньше она уходила
  // гостям вместе с новым треком — и гость начинал новый трек с середины, а потом прыгал в начало.
  // Теперь на время загрузки: «новый трек, позиция старта, пауза». Гость в это время грузит трек без звука,
  // а когда у ведущего заиграет (roomOnPlaying ниже), гостю приходит «играет» — и трек у него уже готов.
  function hostState() {
    const ps = P.state(), md = P.media(), t = ps.track;
    if (!t) return null;
    const pos = md.startAt != null ? md.startAt : ps.position;
    const track = toRoomTrack(t), wa = archiveIdOf(t);
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

  // ---------- гость: включить то же, что у ведущего ----------
  function expectedMs(pb) {
    return pb.positionMs + (pb.playing ? (nowSrv() - pb.at) * (pb.rate || 1) : 0);
  }
  // tol — допустимое расхождение; сразу после старта трека (roomOnPlaying) оно меньше, чтобы догнать время загрузки
  async function guestApply(tol = SYNC_TOL) {
    if (!inRoom() || isHost() || !follow) return;
    const pb = room.playback;
    if (!pb) return;
    syncing++;
    try {
      if (Math.abs((P.state().rate || 1) - (pb.rate || 1)) > 0.001) P.setRate(pb.rate || 1);
      const t = curTrack();
      if (!t || t.id !== String(pb.track.id)) {
        // ведущий ещё грузит трек или на паузе — грузим без звука (hold), иначе включаем сразу
        await P.playTrack(roomEntity(pb.track), { at: Math.max(0, expectedMs(pb) / 1000), hold: !pb.playing, context: "room" });
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
    if (isHost()) onSuggestions();
    paint();
  }

  // ---------- передача ведущего ----------
  // Сервер отдаёт у участника id (members[].id) и принимает POST /api/rooms/{code}/host {memberId}.
  const memberId = (m) => m?.id ?? m?.userId ?? m?.memberId ?? null;
  let confirmFor = null;          // кому ведущий собирается передать управление (подтверждение в окне)
  function roleChanged() {
    follow = true; hostLast = ""; confirmFor = null;
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
    taken.add(s.id);
    W.queue.playNext(roomEntity(s.track, { _room: true }), { quiet: true });      // _room — трек из комнаты (не «волны»)
    dismiss(s.id);
    if (!quiet) showToast(`«${s.track.title}» заиграет следующим`, 2500, { kind: "ok" });
    return true;
  }
  // плеер приложения зовёт перед переходом к следующему треку: берём самое раннее предложение
  const take = () => {
    if (!autoQ || !inRoom() || !isHost()) return false;
    const s = sugList().find((x) => !taken.has(x.id));
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
  }
  function gone(msg) {
    pollGen++;
    const wasGuest = room && !room.isHost;
    room = null; code = ""; follow = true; resumeUntil = 0;
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
    const md = P.media();
    if (t && t.id !== String(pb.track.id)) detach("Ты включил свой трек");
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

  async function paintSetup(box) {
    box.append(el("h2", "", "Слушать вместе"));
    box.append(el("p", "rmlead", `Одна и та же музыка у всех в комнате в один и тот же момент. Каждый слушает со своего ${account()}, ведущий управляет, остальные могут предлагать треки.`));
    let hasKey = false;
    try { hasKey = await invoke("wa_token_exists"); } catch {}
    if (!panel || panel.box !== box) return;
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
    box.append(mk, el("div", "rmor", "или"), row, el("p", "status rmstatus"));
    const done = el("button", "nav", "Закрыть"); done.type = "button"; done.onclick = close;
    const r = el("div", "row"); r.append(done); box.append(r);
    if (hasKey) inp.focus();
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
      if (isHost() && !taken.has(s.id)) {
        btn("▶", "Включить сейчас", () => { taken.add(s.id); P.playTrack(roomEntity(s.track, { _room: true }), { context: "room" }); dismiss(s.id); });
        btn("＋", "Играть следующим", () => queueSug(s));
      }
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
    panel.box.textContent = "";
    if (inRoom()) paintRoom(panel.box); else paintSetup(panel.box);
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
