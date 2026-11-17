// core/profile.js — свой профиль Whisper Archive прямо в приложении: аватар, никнейм, место в хранилище, свои альбомы,
// лайкнутые альбомы и друзья — то же, что на сайте в профиле. Общий модуль ядра: только window.Whisper, команды Rust
// whisper/profile.rs (wa_my_profile, wa_my_nickname, wa_my_avatar, wa_my_avatar_remove), whisper/friends.rs
// (wa_user_profile — свои и лайкнутые альбомы, wa_friends_list, wa_image) и wa_album, и набор интерфейса приложения:
//   kit.page("waprofile", { title, render, btn, bind })  — страница (раздел #waprofilePage.kitpage); кнопку, которая
//                                                          её открывает, выбирает приложение (в Whisper Yandex — «Профиль»);
//   kit.playArchive / kit.toast / kit.confirm.
// Устройства, синхронизацию и отзыв ключей приложение не трогает — это только на сайте (кнопка «Устройства — на сайте»):
// по ключу приложения сервер отдаёт лишь «лицо» (/api/app/me).
// Открыть страницу: Whisper.modules.waprofile.open().
(() => {
  const W = window.Whisper;
  if (!W) return;
  const kit = W.ui.kit;
  const { invoke } = window.__TAURI__.core;
  const toast = (...a) => kit.toast?.(...a);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SITE = "https://origin.whisper-archive.ru/profile/";
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (text, cls, fn, title) => {
    const b = el("button", "nav" + (cls ? " " + cls : ""), text); b.type = "button";
    if (title) b.title = title;
    b.onclick = async (e) => { e.stopPropagation(); b.disabled = true; try { await fn(); } finally { b.disabled = false; } };
    return b;
  };
  const msg = (e) => String(e?.message || e || "ошибка");
  const plural = (n, f) => { const a = n % 100, b = n % 10; return a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b >= 2 && b <= 4 ? f[1] : f[2]; };
  const size = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1).replace(".", ",") + " ГБ" : Math.round(n / 1048576) + " МБ");

  async function cmd(name, args) {
    const r = await invoke(name, args);
    let data = null;
    try { data = r.body ? JSON.parse(r.body) : null; } catch {}
    if (r.status >= 200 && r.status < 300) return data;
    const e = new Error(data?.message || (r.status === 429 ? "слишком часто — подожди немного" : r.status === 404 ? "архив пока не умеет этого — обнови сервер" : `сервер ответил HTTP ${r.status}`));
    e.status = r.status;
    throw e;
  }

  // ---------- картинки (как в core/friends.js: байтами через Rust → blob:) ----------
  const imgs = new Map();
  function imageOf(url) {
    const m = /^\/api\/(users|albums)\/([0-9a-f-]{36})\/(avatar|cover)(?:\?v=([0-9a-f]{1,16}))?$/i.exec(String(url || ""));
    if (!m || !UUID.test(m[2])) return null;
    if (!imgs.has(m[0])) {
      imgs.set(m[0], invoke("wa_image", { kind: m[3].toLowerCase(), id: m[2], v: m[4] || null })
        .then((buf) => URL.createObjectURL(new Blob([buf])))
        .catch(() => { imgs.delete(m[0]); return null; }));
    }
    return imgs.get(m[0]);
  }
  function avatar(u, cls = "") {
    const box = el("span", "frav" + (cls ? " " + cls : ""));
    box.append(el("b", "", (String(u?.nickname || "?").trim()[0] || "?").toUpperCase()));
    imageOf(u?.avatar)?.then((src) => {
      if (!src) return;
      const i = el("img"); i.alt = ""; i.src = src;
      box.append(i); box.classList.add("img");
    });
    return box;
  }
  function cover(url) {
    const box = el("span", "frcover");
    imageOf(url)?.then((src) => { if (!src) return; const i = el("img"); i.alt = ""; i.src = src; box.append(i); });
    return box;
  }

  // ---------- данные ----------
  let page = null;
  let hasKey = null, me = null, prof = null, friends = null, err = "", loading = null;
  let tab = "albums", editing = false, editMsg = "";
  const openAlbums = new Map();          // id альбома → "loading" | { tracks, author } | { error }

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      try { hasKey = !!(await invoke("wa_token_exists")); } catch { hasKey = false; }
      if (!hasKey) { me = prof = friends = null; return; }
      try {
        me = await cmd("wa_my_profile");
        err = "";
      } catch (e) { me = null; err = e.status === 403 ? msg(e) + " Войди в архив заново — ключ нужен с доступом «запись»." : msg(e); return; }
      const [p, f] = await Promise.allSettled([cmd("wa_user_profile", { id: String(me.id) }), cmd("wa_friends_list")]);
      prof = p.status === "fulfilled" ? p.value : { albums: [], likedAlbums: [], error: msg(p.reason) };
      friends = f.status === "fulfilled" ? f.value : { friends: [], incoming: [], outgoing: [], error: msg(f.reason) };
    })();
    try { await loading; } finally { loading = null; }
  }

  // ---------- действия ----------
  async function saveNick(value) {
    editMsg = "";
    try {
      const r = await invoke("wa_my_nickname", { nickname: value });
      let d = null;
      try { d = r.body ? JSON.parse(r.body) : null; } catch {}
      if (r.status < 200 || r.status >= 300) { editMsg = d?.message || `сервер ответил HTTP ${r.status}`; paint(); return; }
      me = d || me; editing = false;
      toast("Никнейм изменён", 3000, { kind: "ok" });
      W.modules.friends?.refresh?.();
    } catch (e) { editMsg = msg(e); }
    paint();
  }
  const picker = el("input"); picker.type = "file"; picker.accept = "image/png,image/jpeg,image/webp,image/gif"; picker.hidden = true;
  document.body.append(picker);
  picker.onchange = async () => {
    const f = picker.files?.[0]; picker.value = "";
    if (!f) return;
    if (f.size > 2 * 1048576) { toast("Аватар больше 2 МБ — выбери картинку поменьше", 5000, { kind: "err" }); return; }
    try {
      const r = await invoke("wa_my_avatar", new Uint8Array(await f.arrayBuffer()));
      let d = null;
      try { d = r.body ? JSON.parse(r.body) : null; } catch {}
      if (r.status < 200 || r.status >= 300) throw new Error(d?.message || `сервер ответил HTTP ${r.status}`);
      if (d?.avatar) me = { ...me, avatar: d.avatar };
      toast("Аватар обновлён", 3000, { kind: "ok" });
      W.modules.friends?.refresh?.();
    } catch (e) { toast("Аватар не сохранился: " + msg(e), 6000, { kind: "err" }); }
    paint();
  };
  async function removeAvatar() {
    const ok = await kit.confirm?.({ title: "Убрать аватар?", text: "Вместо картинки будет первая буква никнейма.", ok: "Убрать", danger: true });
    if (!ok) return;
    try { await cmd("wa_my_avatar_remove"); me = { ...me, avatar: null }; toast("Аватар убран", 3000, { kind: "ok" }); }
    catch (e) { toast("Не получилось: " + msg(e), 5000, { kind: "err" }); }
    paint();
  }
  const openSite = () => { try { window.__TAURI__.opener.openUrl(SITE + encodeURIComponent(String(me.id))); } catch {} };

  async function toggleAlbum(a) {
    const id = String(a.id);
    if (openAlbums.has(id)) { openAlbums.delete(id); paint(); return; }
    openAlbums.set(id, "loading"); paint();
    try {
      const r = await cmd("wa_album", { id });
      const durSec = (v) => (typeof v === "number" && isFinite(v) ? (v > 36000 ? v / 1000 : v) : (() => {
        const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(String(v || ""));
        return m ? (+(m[1] || 0)) * 86400 + (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]) : 0;
      })());
      const tracks = (Array.isArray(r?.tracks) ? r.tracks : []).filter((t) => UUID.test(String(t?.id || "")))
        .map((t) => ({ id: String(t.id), title: String(t.title || "Трек"), durationMs: Math.round(durSec(t.duration) * 1000) }));
      openAlbums.set(id, { tracks, author: String(r?.author || a.author || me?.nickname || "") });
    } catch (e) { openAlbums.set(id, { error: msg(e) }); }
    paint();
  }
  function play(a, st, i) {
    if (typeof kit.playArchive !== "function") { toast("Здесь нельзя послушать альбом архива", 4000); return; }
    if (!kit.playArchive(st.tracks, i, { author: st.author, album: String(a.id) })) toast("В альбоме нет треков", 3000);
  }

  // ---------- рисование ----------
  function hero(box) {
    const head = el("div", "wpro-head");
    const av = avatar(me, "big wpro-av");
    av.title = "Изменить аватар";
    av.tabIndex = 0;
    av.onclick = () => picker.click();
    av.onkeydown = (e) => { if (e.key === "Enter") picker.click(); };
    head.append(av);
    const tx = el("div", "wpro-tx");
    if (editing) {
      const f = el("form", "wpro-nick");
      const inp = el("input", "field"); inp.type = "text"; inp.maxLength = 32; inp.value = me.nickname || ""; inp.spellcheck = false;
      f.append(inp, btn("Сохранить", "active", () => saveNick(inp.value)), btn("Отмена", "", () => { editing = false; editMsg = ""; paint(); }));
      f.onsubmit = (e) => { e.preventDefault(); saveNick(inp.value); };
      tx.append(f);
      if (editMsg) tx.append(el("p", "frnote err", editMsg));
      setTimeout(() => { inp.focus(); inp.select(); });
    } else tx.append(el("h2", "wpro-name", me.nickname || "—"));
    const sub = [me.email, me.createdAt ? "в архиве с " + new Date(me.createdAt).toLocaleDateString(document.documentElement.lang === "en" ? "en-GB" : "ru-RU", { month: "long", year: "numeric" }) : ""].filter(Boolean).join(" · ");
    if (sub) tx.append(el("small", "wpro-sub", sub));
    const st = me.storage;
    if (st && st.limit > 0) {
      const bar = el("div", "wpro-store");
      const fill = el("i"); fill.style.width = Math.min(100, (st.used / st.limit) * 100).toFixed(1) + "%";
      bar.append(fill);
      tx.append(bar, el("small", "wpro-sub", `Занято ${size(st.used)} из ${size(st.limit)}`));
    }
    const acts = el("div", "fracts wpro-acts");
    if (!editing) {
      const next = me.nicknameChangeAvailableAt ? new Date(me.nicknameChangeAvailableAt) : null;
      const nb = btn("Изменить никнейм", "", () => { editing = true; editMsg = ""; paint(); });
      if (next && next > new Date()) { nb.disabled = true; nb.title = "Никнейм можно менять раз в час — снова после " + next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
      acts.append(nb);
    }
    acts.append(btn("Изменить аватар", "", () => picker.click()));
    if (me.avatar) acts.append(btn("Убрать аватар", "", removeAvatar));
    acts.append(btn("Устройства — на сайте ↗", "", openSite, "Устройства, синхронизация и ключи меняются только на сайте архива"));
    tx.append(acts);
    head.append(tx);
    box.append(head);
  }

  function albumGrid(box, list, liked) {
    const grid = el("div", "fralbums");
    for (const a of list) {
      const st = openAlbums.get(String(a.id));
      const card = el("div", "fralbum" + (st ? " on" : ""));
      card.tabIndex = 0;
      card.append(cover(a.cover));
      const n = +a.trackCount || 0;
      const meta = el("div", "frtx");
      const line = [liked && a.author ? String(a.author) : "", `${n} ${plural(n, ["трек", "трека", "треков"])}`,
        !liked && String(a.visibility || "").toLowerCase() === "private" ? "скрытый" : ""].filter(Boolean).join(" · ");
      meta.append(el("b", "", String(a.title || "Без названия")), el("small", "", line));
      card.append(meta);
      card.onclick = () => toggleAlbum(a);
      card.onkeydown = (e) => { if (e.key === "Enter") toggleAlbum(a); };
      grid.append(card);
      if (!st) continue;
      const tl = el("div", "fraltracks");
      if (st === "loading") tl.append(el("p", "frnote", "Загружаю треки…"));
      else if (st.error) tl.append(el("p", "frnote err", "Не открылся: " + st.error));
      else {
        const bar = el("div", "fracts");
        bar.append(btn("▶ Слушать альбом", "active", () => play(a, st, 0)));
        tl.append(bar);
        st.tracks.forEach((t, i) => {
          const r = el("div", "frtrack");
          const s = t.durationMs / 1000;
          r.append(el("span", "frn", String(i + 1)), el("span", "frt", t.title), el("span", "frd", s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : ""));
          r.title = "Слушать";
          r.onclick = () => play(a, st, i);
          tl.append(r);
        });
        if (!st.tracks.length) tl.append(el("p", "frnote", "В альбоме пока нет треков."));
      }
      grid.append(tl);
    }
    box.append(grid);
  }

  function friendsTab(box) {
    const F = friends || {};
    if (F.error) box.append(el("p", "frnote err", "Не удалось загрузить друзей: " + F.error));
    const inc = Array.isArray(F.incoming) ? F.incoming : [];
    if (inc.length) {
      const s = el("div", "wpro-req");
      s.append(el("span", "", `Заявки в друзья: ${inc.length}`), btn("Открыть", "active", () => W.modules.friends?.open()));
      box.append(s);
    }
    const list = (Array.isArray(F.friends) ? F.friends : []).filter((u) => UUID.test(String(u?.id || "")) && u.nickname)
      .sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
    for (const u of list) {
      const row = el("div", "frrow open");
      const av = avatar(u);
      const d = el("i", "frdot" + (u.online ? " on" : "")); d.title = u.online ? "Приложение открыто" : "Не в сети";
      av.append(d);
      const tx = el("div", "frtx");
      tx.append(el("b", "", u.nickname));
      row.append(av, tx);
      row.tabIndex = 0;
      row.onclick = () => W.modules.friends?.profile(String(u.id));
      row.onkeydown = (e) => { if (e.key === "Enter") W.modules.friends?.profile(String(u.id)); };
      box.append(row);
    }
    if (!list.length && !F.error) box.append(el("p", "frempty", "Пока никого — найди друга по никнейму."));
    const more = el("div", "fracts");
    more.append(btn("Все друзья и поиск", "", () => W.modules.friends?.open()));
    box.append(more);
  }

  function paint() {
    const box = page?.el;
    if (!box || box.hidden) return;
    box.textContent = "";
    const wrap = el("div", "friends wpro");
    if (hasKey === false) {
      const p = el("div", "frempty");
      p.append(el("p", "", "Профиль живёт в Whisper Archive: войди в архив, чтобы видеть свои альбомы, лайки и друзей, менять ник и аватар."));
      const login = W.modules.archive?.login;
      if (typeof login === "function") p.append(btn("Войти в Whisper Archive", "active", async () => { await login("Чтобы открыть профиль"); await load(); paint(); }));
      wrap.append(p);
    } else if (!me) {
      wrap.append(el("p", "frnote" + (err ? " err" : ""), err ? "Не удалось открыть профиль: " + err : "Загружаю профиль…"));
      if (err) { const r = el("div", "fracts"); r.append(btn("Повторить", "active", async () => { await load(); paint(); })); wrap.append(r); }
    } else {
      hero(wrap);
      const albums = (Array.isArray(prof?.albums) ? prof.albums : []).filter((a) => UUID.test(String(a?.id || "")));
      const liked = (Array.isArray(prof?.likedAlbums) ? prof.likedAlbums : []).filter((a) => UUID.test(String(a?.id || "")));
      const fr = Array.isArray(friends?.friends) ? friends.friends.length : 0;
      const tabs = el("div", "chips wpro-tabs");
      for (const [k, label] of [["albums", `Альбомы · ${albums.length}`], ["liked", `Лайки · ${liked.length}`], ["friends", `Друзья · ${fr}`]]) {
        const c = el("button", "chip" + (tab === k ? " active" : ""), label); c.type = "button";
        c.onclick = () => { tab = k; paint(); };
        tabs.append(c);
      }
      wrap.append(tabs);
      const sec = el("section", "frsec");
      if (prof?.error && tab !== "friends") sec.append(el("p", "frnote err", "Не удалось загрузить альбомы: " + prof.error));
      if (tab === "albums") { if (albums.length) albumGrid(sec, albums, false); else if (!prof?.error) sec.append(el("p", "frempty", "Своих альбомов пока нет — их можно загрузить в архив из меню трека или на сайте.")); }
      else if (tab === "liked") { if (liked.length) albumGrid(sec, liked, true); else if (!prof?.error) sec.append(el("p", "frempty", "Лайкнутых альбомов пока нет.")); }
      else friendsTab(sec);
      wrap.append(sec);
    }
    box.append(wrap);
  }

  page = kit.page?.("waprofile", {
    title: "Профиль Whisper Archive",
    btn: kit.profileButton?.() || undefined,      // кнопка, которая открывает профиль (функция: kit отдаёт только функции)
    bind: false,
    render: () => { paint(); load().then(paint); },
  }) || null;
  if (!page) return;
  window.addEventListener("focus", () => { if (page.shown() && !editing) load().then(paint); });

  W.modules.waprofile = { open: () => page.open() };
})();
