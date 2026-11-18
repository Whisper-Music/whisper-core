// core/friends.js — «Друзья»: список друзей Whisper Archive, заявки, поиск людей, профиль друга (аватар, ник, публичные
// альбомы — послушать прямо здесь) и «Позвать в комнату» (core/together.js). Общий модуль ядра: только window.Whisper,
// команды Rust whisper/friends.rs (wa_friend*, wa_user_profile, wa_image) и набор интерфейса приложения:
//   kit.page("friends", { title, render })  — страница в боковой панели (кнопка #friendsBtn, раздел #friendsPage);
//   kit.playArchive(tracks, start, o)       — послушать треки альбома архива;
//   kit.toast / kit.confirm.
// Сервер действует только от имени владельца ключа: чужие списки друзей не видны никому.
// Картинки архива страница загрузить сама не может (CSP) — Rust отдаёт их байтами, показываем через blob:.
(() => {
  const W = window.Whisper;
  if (!W) return;
  const kit = W.ui.kit;
  const { invoke } = window.__TAURI__.core;
  const toast = (...a) => kit.toast?.(...a);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (text, cls, fn, title) => {
    const b = el("button", "nav" + (cls ? " " + cls : ""), text); b.type = "button";
    if (title) b.title = title;
    b.onclick = async (e) => { e.stopPropagation(); b.disabled = true; try { await fn(); } finally { b.disabled = false; } };
    return b;
  };

  async function cmd(name, args) {
    const r = await invoke(name, args);
    let data = null;
    try { data = r.body ? JSON.parse(r.body) : null; } catch {}
    if (r.status >= 200 && r.status < 300) return data;
    const type = String(data?.type || "");
    const e = new Error(FR_ERR[type] || data?.message || (r.status === 429 ? "слишком часто — подожди немного" : `сервер ответил HTTP ${r.status}`));
    e.status = r.status;
    e.type = type;
    throw e;
  }
  // отказы сервера друзей — понятными словами (сервер присылает и свой текст, но эти точнее для приложения)
  const FR_ERR = {
    declined_recently: "он недавно отклонил твою заявку — позвать снова можно через неделю",
    you_blocked: "ты его заблокировал — сначала разблокируй",
    not_allowed: "этот человек не принимает от тебя заявки",
  };
  const msg = (e) => String(e?.message || e || "ошибка");

  // ---------- картинки ----------
  // адрес с сервера: /api/users/{id}/avatar?v=… или /api/albums/{id}/cover → байты через Rust → blob:
  const imgs = new Map();
  function imageOf(url) {
    const m = /^\/api\/(users|albums)\/([0-9a-f-]{36})\/(avatar|cover)(?:\?v=([0-9a-f]{1,16}))?$/i.exec(String(url || ""));
    if (!m || !UUID.test(m[2])) return null;
    const key = m[0];
    if (!imgs.has(key)) {
      imgs.set(key, invoke("wa_image", { kind: m[3].toLowerCase(), id: m[2], v: m[4] || null })
        .then((buf) => URL.createObjectURL(new Blob([buf])))
        .catch(() => { imgs.delete(key); return null; }));
    }
    return imgs.get(key);
  }
  // аватар — кружок с первой буквой; картинка встаёт поверх, когда загрузится
  function avatar(u, cls = "") {
    const box = el("span", "frav" + (cls ? " " + cls : ""));
    box.append(el("b", "", (String(u?.nickname || "?").trim()[0] || "?").toUpperCase()));
    imageOf(u?.avatar)?.then((src) => {
      if (!src) return;
      const i = el("img"); i.alt = ""; i.src = src;
      box.append(i);
      box.classList.add("img");
    });
    return box;
  }
  function cover(url) {
    const box = el("span", "frcover");
    imageOf(url)?.then((src) => { if (!src) return; const i = el("img"); i.alt = ""; i.src = src; box.append(i); });
    return box;
  }

  // ---------- данные ----------
  let page = null;                    // { el, open, shown } от kit.page
  let hasKey = null;
  let data = { friends: [], incoming: [], outgoing: [], blocked: [] };
  let recent = [];                    // «слушали вместе» (core/together.js → /api/rooms/friends), кто ещё не в друзьях
  let loadedAt = 0, loading = null, loadErr = "";
  let found = null, foundQ = "", searching = false;
  let view = null;                    // null — список; { id, nickname, avatar } — профиль
  const seenIncoming = new Set();
  const APP_LABEL = { yandex: "Яндекс", vk: "VK" };
  const users = (a) => (Array.isArray(a) ? a : []).filter((u) => UUID.test(String(u?.id || "")) && u.nickname);

  async function load(force = false) {
    if (loading) return loading;
    if (!force && Date.now() - loadedAt < 10000) return;
    loading = (async () => {
      try { hasKey = !!(await invoke("wa_token_exists")); } catch { hasKey = false; }
      if (!hasKey) { data = { friends: [], incoming: [], outgoing: [], blocked: [] }; recent = []; return; }
      try {
        const v = await cmd("wa_friends_list");
        data = { friends: users(v?.friends), incoming: users(v?.incoming), outgoing: users(v?.outgoing), blocked: users(v?.blocked) };
        loadErr = "";
        loadedAt = Date.now();
      } catch (e) { loadErr = e.status === 404 ? "архив пока не умеет друзей — обнови сервер" : msg(e); }
      try {
        const r = await cmd("wa_room_friends");
        const mine = new Set([...data.friends, ...data.incoming, ...data.outgoing, ...data.blocked].map((u) => String(u.id)));
        recent = users(r).filter((u) => !u.friend && !mine.has(String(u.id))).slice(0, 30);
      } catch { recent = []; }
      badge();
    })();
    try { await loading; } finally { loading = null; }
  }

  // новые заявки — число на кнопке «Друзья» и подсказка один раз
  function badge() {
    const b = document.getElementById("friendsBtn");
    const n = data.incoming.length;
    if (b) { if (n) b.dataset.badge = n > 9 ? "9+" : String(n); else delete b.dataset.badge; }
    for (const u of data.incoming) {
      if (seenIncoming.has(u.id)) continue;
      seenIncoming.add(u.id);
      if (page?.shown()) continue;
      toast(`${u.nickname} хочет добавить тебя в друзья`, 8000, { action: { label: "Открыть", fn: () => page?.open() } });
    }
  }

  // ---------- действия ----------
  async function act(kind, u) {
    const id = String(u.id);
    try {
      if (kind === "add") {
        const r = await cmd("wa_friend_request", { id });
        toast(r?.relation === "friend" ? `${u.nickname} теперь в друзьях` : `Заявка отправлена — ${u.nickname} увидит её в приложении или на сайте`, 4000, { kind: "ok" });
      } else if (kind === "accept") {
        await cmd("wa_friend_accept", { id });
        toast(`${u.nickname} теперь в друзьях`, 3000, { kind: "ok" });
      } else if (kind === "block") {
        const ok = await kit.confirm?.({ title: `Заблокировать ${u.nickname}?`, text: "Дружба и заявки пропадут. Он не найдёт тебя в поиске, не сможет позвать в друзья или в комнату и не войдёт в твою комнату. Разблокировать можно в любой момент.", ok: "Заблокировать", danger: true });
        if (!ok) return;
        await cmd("wa_friend_block", { id });
        toast(`${u.nickname} заблокирован`, 3000, { kind: "ok" });
      } else if (kind === "unblock") {
        await cmd("wa_friend_unblock", { id });
        toast(`${u.nickname} разблокирован`, 3000, { kind: "ok" });
      } else {
        if (kind === "remove") {
          const ok = await kit.confirm?.({ title: "Убрать из друзей?", text: `${u.nickname} пропадёт из твоих друзей, а ты — из его. Добавить друг друга можно будет снова.`, ok: "Убрать", danger: true });
          if (!ok) return;
        }
        await cmd("wa_friend_remove", { id });
      }
    } catch (e) { toast("Не получилось: " + msg(e), 5000, { kind: "err" }); }
    await load(true);
    W.modules.together?.refresh?.();
    if (found) found = found.map((x) => (String(x.id) === id ? { ...x, relation: relationOf(id) } : x));
    paint();
  }
  function relationOf(id) {
    id = String(id);
    if (data.friends.some((u) => String(u.id) === id)) return "friend";
    if (data.incoming.some((u) => String(u.id) === id)) return "received";
    if (data.outgoing.some((u) => String(u.id) === id)) return "sent";
    if (data.blocked.some((u) => String(u.id) === id)) return "blocked";
    return "none";
  }
  async function invite(u) {
    const T = W.modules.together;
    if (!T?.invite) { toast("«Слушать вместе» недоступно в этом приложении", 4000); return; }
    await T.invite(u);
    paint();
  }
  // кнопки по тому, кто он мне
  function relButtons(u, rel, row) {
    if (rel === "friend") {
      const st = W.modules.together?.status?.(String(u.id));
      const label = st === "here" ? "В комнате" : st === "pending" ? "Позван ✓" : "Позвать";
      const b = btn(label, st ? "" : "active", () => invite(u), W.modules.together?.inRoom?.() ? "Друг получит приглашение в комнату" : "Создать комнату и позвать");
      if (st === "here") b.disabled = true;
      row.append(b);
    } else if (rel === "received") {
      row.append(btn("Принять", "active", () => act("accept", u)), btn("Отклонить", "", () => act("decline", u)));
    } else if (rel === "sent") {
      row.append(el("span", "frnote", "Заявка отправлена"), btn("Отменить", "", () => act("cancel", u)));
    } else if (rel === "none") {
      row.append(btn("Добавить в друзья", "active", () => act("add", u)));
    } else if (rel === "blocked") {
      row.append(el("span", "frnote", "Заблокирован"), btn("Разблокировать", "", () => act("unblock", u)));
    }
  }

  // ---------- поиск ----------
  async function search(q) {
    q = String(q || "").trim();
    if (!q) { found = null; foundQ = ""; paint(); return; }
    searching = true; foundQ = q; paint();
    try { found = users(await cmd("wa_friends_search", { q })); }
    catch (e) { found = []; toast("Поиск не удался: " + msg(e), 4000, { kind: "err" }); }
    searching = false;
    paint();
  }

  // ---------- рисование ----------
  // presence с сервера: online | away («отошёл», оранжевая точка) | offline; у заявок и «слушали вместе» — null
  const away = (u) => u?.presence === "away";
  function userRow(u, rel, { online, open = true } = {}) {
    const row = el("div", "frrow" + (open ? " open" : ""));
    const av = avatar(u);
    if (online != null) {
      const d = el("i", "frdot" + (away(u) ? " away" : online ? " on" : ""));
      d.title = away(u) ? "Отошёл" : online ? "Приложение открыто" : "Не в сети";
      av.append(d);
    }
    const tx = el("div", "frtx");
    tx.append(el("b", "", u.nickname));
    if (u.app) tx.append(el("small", "", "Whisper " + (APP_LABEL[u.app] || String(u.app).slice(0, 12))));
    else if (u.metCount) tx.append(el("small", "", "слушали вместе"));
    row.append(av, tx);
    const acts = el("div", "fracts");
    relButtons(u, rel, acts);
    if (rel === "friend") acts.append(btn("✕", "frmore", () => act("remove", u), "Убрать из друзей"));
    row.append(acts);
    if (open) { row.tabIndex = 0; row.onclick = () => openProfile(u); row.onkeydown = (e) => { if (e.key === "Enter") openProfile(u); }; }
    return row;
  }
  function section(box, title, list, rel, o) {
    if (!list.length) return;
    const s = el("section", "frsec");
    s.append(el("h3", "", title));
    for (const u of list) s.append(userRow(u, rel, o?.(u)));
    box.append(s);
  }

  function paintList(box) {
    if (hasKey === false) {
      const p = el("div", "frempty");
      p.append(el("p", "", "Друзья живут в Whisper Archive: войди в архив, чтобы добавлять людей, видеть их альбомы и звать слушать вместе."));
      const login = W.modules.archive?.login;
      if (typeof login === "function") p.append(btn("Войти в Whisper Archive", "active", async () => { await login("Чтобы добавлять друзей"); await load(true); paint(); }));
      box.append(p);
      return;
    }
    const f = el("form", "frfind");
    const inp = el("input", "search frq"); inp.type = "search"; inp.placeholder = "Найти по никнейму или ссылке на профиль"; inp.maxLength = 200;
    inp.autocomplete = "off"; inp.spellcheck = false; inp.value = foundQ;
    f.append(inp, btn("Найти", "active", () => search(inp.value)));
    f.onsubmit = (e) => { e.preventDefault(); search(inp.value); };
    box.append(f);
    if (searching) box.append(el("p", "frnote", "Ищу…"));
    else if (found) {
      const s = el("section", "frsec frfound");
      const h = el("h3", "", found.length ? "Нашлись" : `Никого не нашлось по «${foundQ}»`);
      s.append(h);
      for (const u of found) s.append(userRow(u, u.relation));
      s.append(btn("Скрыть результаты", "frclear", () => { found = null; foundQ = ""; paint(); }));
      box.append(s);
    }
    if (loadErr) box.append(el("p", "frnote err", "Не удалось загрузить друзей: " + loadErr));
    section(box, "Заявки в друзья", data.incoming, "received");
    // в сети — сверху, отошедшие — за ними, не в сети — внизу
    const rk = (u) => (away(u) ? 1 : u.online ? 0 : 2);
    const fr = [...data.friends].sort((a, b) => rk(a) - rk(b));
    section(box, data.friends.length ? `Друзья · ${data.friends.length}` : "Друзья", fr, "friend", (u) => ({ online: !!u.online }));
    if (!data.friends.length && !loadErr) box.append(el("p", "frempty", "Пока никого. Найди друга по никнейму — он увидит заявку в приложении или в профиле на сайте."));
    section(box, "Ждут ответа", data.outgoing, "sent");
    section(box, "Слушали вместе", recent, "none", (u) => ({ online: !!u.online }));
    section(box, `Заблокированные · ${data.blocked.length}`, data.blocked, "blocked", () => ({ open: false }));
    box.append(el("p", "frnote", "Твоих друзей видишь только ты. Друзья видят твой ник, аватар и публичные альбомы."));
  }

  // ---------- профиль друга ----------
  let prof = null, profFor = "", profErr = "";
  const openAlbums = new Map();       // id альбома → { tracks } | "loading" | { error }
  const durSec = (v) => {
    if (typeof v === "number" && isFinite(v)) return v > 36000 ? v / 1000 : v;
    const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(String(v || ""));
    return m ? (+(m[1] || 0)) * 86400 + (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]) : 0;
  };
  const mmss = (s) => (s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "");
  async function openProfile(u) {
    view = { id: String(u.id), nickname: u.nickname, avatar: u.avatar };
    if (profFor !== view.id) { prof = null; profErr = ""; openAlbums.clear(); }
    paint();
    document.querySelector(".main")?.scrollTo?.(0, 0);
    if (prof && profFor === view.id) return;
    const id = view.id;
    try {
      const p = await cmd("wa_user_profile", { id });
      if (view?.id !== id) return;
      prof = p; profFor = id;
      if (p?.nickname) view.nickname = p.nickname;
      if (p?.avatar !== undefined) view.avatar = p.avatar;
    } catch (e) { if (view?.id === id) profErr = e.status === 404 ? "пользователь не найден" : msg(e); }
    paint();
  }
  async function toggleAlbum(a) {
    const id = String(a.id);
    if (openAlbums.has(id)) { openAlbums.delete(id); paint(); return; }
    openAlbums.set(id, "loading"); paint();
    try {
      const r = await cmd("wa_album", { id });
      const tracks = (Array.isArray(r?.tracks) ? r.tracks : []).filter((t) => UUID.test(String(t?.id || "")))
        .map((t) => ({ id: String(t.id), title: String(t.title || "Трек"), durationMs: Math.round(durSec(t.duration) * 1000) }));
      openAlbums.set(id, { tracks, author: String(r?.author || prof?.nickname || "") });
    } catch (e) { openAlbums.set(id, { error: msg(e) }); }
    paint();
  }
  function play(a, st, i) {
    if (typeof kit.playArchive !== "function") { toast("Здесь нельзя послушать альбом архива", 4000); return; }
    if (!kit.playArchive(st.tracks, i, { author: st.author, album: String(a.id) })) toast("В альбоме нет треков", 3000);
  }
  function paintProfile(box) {
    const u = view;
    const top = el("div", "frback");
    top.append(btn("← Все друзья", "", () => { view = null; paint(); }));
    box.append(top);
    const head = el("div", "frhead");
    head.append(avatar(u, "big"));
    const tx = el("div", "frtx");
    tx.append(el("h3", "", u.nickname));
    const rel = relationOf(u.id);
    tx.append(el("small", "", { friend: "В друзьях", received: "Хочет добавить тебя в друзья", sent: "Заявка отправлена", none: "Не в друзьях", blocked: "Заблокирован" }[rel]));
    const acts = el("div", "fracts");
    relButtons(u, rel, acts);
    if (rel === "friend") acts.append(btn("Убрать из друзей", "", () => act("remove", u)));
    if (rel !== "blocked") acts.append(btn("Заблокировать", "", () => act("block", u), "Не сможет найти тебя, позвать и войти в твою комнату"));
    tx.append(acts);
    head.append(tx);
    box.append(head);
    if (profErr) { box.append(el("p", "frnote err", "Не удалось открыть профиль: " + profErr)); return; }
    if (!prof) { box.append(el("p", "frnote", "Загружаю профиль…")); return; }
    const albums = (Array.isArray(prof.albums) ? prof.albums : []).filter((a) => UUID.test(String(a?.id || "")) && String(a.visibility || "").toLowerCase() === "public");
    const s = el("section", "frsec");
    s.append(el("h3", "", albums.length ? `Публичные альбомы · ${albums.length}` : "Публичных альбомов нет"));
    const grid = el("div", "fralbums");
    for (const a of albums) {
      const st = openAlbums.get(String(a.id));
      const card = el("div", "fralbum" + (st ? " on" : ""));
      card.tabIndex = 0;
      card.append(cover(a.cover));
      const n = +a.trackCount || 0;
      const meta = el("div", "frtx");
      meta.append(el("b", "", String(a.title || "Без названия")), el("small", "", `${n} ${n % 10 === 1 && n % 100 !== 11 ? "трек" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 > 20) ? "трека" : "треков"}`));
      card.append(meta);
      card.onclick = () => toggleAlbum(a);
      card.onkeydown = (e) => { if (e.key === "Enter") toggleAlbum(a); };
      grid.append(card);
      if (!st) continue;
      const list = el("div", "fraltracks");
      if (st === "loading") list.append(el("p", "frnote", "Загружаю треки…"));
      else if (st.error) list.append(el("p", "frnote err", "Не открылся: " + st.error));
      else {
        const bar = el("div", "fracts");
        bar.append(btn("▶ Слушать альбом", "active", () => play(a, st, 0)));
        list.append(bar);
        st.tracks.forEach((t, i) => {
          const r = el("div", "frtrack");
          r.append(el("span", "frn", String(i + 1)), el("span", "frt", t.title), el("span", "frd", mmss(t.durationMs / 1000)));
          r.title = "Слушать";
          r.onclick = () => play(a, st, i);
          list.append(r);
        });
        if (!st.tracks.length) list.append(el("p", "frnote", "В альбоме пока нет треков."));
      }
      grid.append(list);
    }
    s.append(grid);
    box.append(s);
  }

  function paint() {
    const box = page?.el;
    if (!box || box.hidden) return;
    const keepFocus = document.activeElement?.classList?.contains("frq");
    box.textContent = "";
    const wrap = el("div", "friends");
    if (view) paintProfile(wrap); else paintList(wrap);
    box.append(wrap);
    if (keepFocus) wrap.querySelector(".frq")?.focus();
  }

  // ---------- страница и обновление ----------
  page = kit.page?.("friends", {
    title: "Друзья",
    render: () => { paint(); load().then(paint); },
  }) || null;
  if (!page) return;

  // раз в минуту, пока страница открыта (и раз в 5 минут в фоне — чтобы заметить новые заявки)
  let tick = 0;
  setInterval(() => {
    tick++;
    if (document.hidden && !page.shown()) return;
    if (page.shown() || tick % 5 === 0) load(true).then(() => { if (page.shown() && !view) paint(); });
  }, 60000);
  setTimeout(() => load(true), 4000);
  // вход в архив или выход — список другой
  window.addEventListener("focus", () => { if (page.shown()) load().then(paint); });

  W.modules.friends = {
    open: () => page.open(),
    profile: (id) => { if (UUID.test(String(id || ""))) { page.open(); openProfile({ id: String(id), nickname: "…" }); } },
    refresh: () => load(true).then(paint),
  };
})();
