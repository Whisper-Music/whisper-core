"use strict";
// Очередь и история прослушивания — общий модуль приложений Whisper (рядом с ядром, core/whisper-core.js).
// Выезжающая справа панель: «Сейчас играет», «Далее» (следующие треки — можно убрать или перетащить)
// и «История» (всё, что играло, по дням). Открывается кнопкой в плеере, кнопкой «История прослушивания»
// у выбора станций и клавишей Q.
//
// Работает только через ядро: что играет и что дальше — Whisper.player / Whisper.queue, когда обновиться — события,
// где встать — роли интерфейса (player.volume, radio.stations, main, player…), подсказки, подтверждения, меню трека,
// ссылки на артистов и обложки — набор интерфейса приложения (Whisper.ui.kit). Переменных приложения не знает.
// Нужен файл queue.css. Подробно — docs/CORE.md, «Общие модули».
(() => {
  const W = window.Whisper;
  if (!W) { console.error("queue.js: нет ядра Whisper — подключи core/whisper-core.js раньше"); return; }
  const kit = W.ui.kit;
  const HIST_KEY = W.app.storage + "history";
  const HIST_MAX = 300;
  const NEXT_SHORT = 5, NEXT_LONG = 50;
  const svg = (d) => `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="${d}"/></svg>`;
  const IC = {
    queue: svg("M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18A3 3 0 1 0 19 17V8h3V6h-5z"),
    history: svg("M13 3a9 9 0 0 0-9 9H1l3.9 3.9L9 12H6a7 7 0 1 1 2.05 4.95l-1.42 1.42A9 9 0 1 0 13 3zm-1 5v5l4.25 2.52.77-1.28-3.52-2.09V8z"),
    x: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };
  const roleEl = (role) => W.ui.all(role)[0] || null;
  const inRole = (t, ...roles) => roles.some((r) => { const s = W.ui.selector(r); try { return !!(s && t.closest?.(s)); } catch { return false; } });

  // ---------- история ----------
  // В хранилище — то, что приложение считает нужным сохранить о треке (provider.store), как было у «сырого» трека;
  // в сущность ядра превращается при показе.
  // Каждый трек — в истории один раз: послушал снова (или стоит повтор) — запись поднимается наверх с новым временем.
  // Старые истории с повторами чистятся при загрузке (остаётся самое свежее прослушивание).
  const seen = new Set();
  const hist = (() => {
    try { const v = JSON.parse(localStorage.getItem(HIST_KEY)); return Array.isArray(v) ? v : []; } catch { return []; }
  })().filter((h) => h && h.t && h.t.id != null && typeof h.t.title === "string" && Number.isFinite(h.at))
    .sort((a, b) => b.at - a.at)
    .filter((h) => { const k = String(h.t.id); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, HIST_MAX);
  let saveTimer = 0;
  const saveHist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(HIST_KEY, JSON.stringify(hist)); } catch {} }, 300);
  };
  // трек включили (повтор после сбоя — не считается)
  W.on("start", ({ track: t }) => {
    if (!t || t.id == null) return;
    const id = String(t.id);
    const i = hist.findIndex((h) => String(h.t.id) === id);
    if (i >= 0) hist.splice(i, 1);
    hist.unshift({ t: W.provider()?.store?.(t.raw) ?? t.raw ?? t, at: Date.now() });
    if (hist.length > HIST_MAX) hist.length = HIST_MAX;
    saveHist();
    refresh();
  });

  // ---------- панель ----------
  const panel = document.createElement("aside");
  panel.id = "qPanel"; panel.className = "panel qpanel"; panel.hidden = true;
  panel.setAttribute("aria-label", "Очередь и история прослушивания");
  panel.innerHTML = `
    <div class="qhead"><b>Очередь и история</b><button class="qclose" title="Закрыть (Esc)">${IC.x}</button></div>
    <div class="qbody">
      <section class="qsec"><h4>Сейчас играет</h4><ul class="list qnow"></ul></section>
      <section class="qsec qnextsec"><h4><span>Далее</span><small class="qsrc"></small></h4>
        <ul class="list qnext"></ul><p class="qempty qnextempty"></p>
        <button class="qmore" hidden></button></section>
      <section class="qsec"><h4><span>История прослушивания</span><button class="qclear" title="Очистить историю">Очистить</button></h4>
        <div class="qhist"></div><p class="qempty qhistempty">Здесь появятся треки, которые ты слушал.</p></section>
    </div>`;
  document.body.append(panel);
  const el = (s) => panel.querySelector(s);
  let longNext = false, dragging = false, pending = false;

  function row(t, { onClick, grip, remove, time, more = true } = {}) {
    const li = document.createElement("li");
    li.dataset.id = t.id;
    if (t.id === W.player.state().track?.id) li.classList.add("playing");
    if (grip) li.append(grip);
    const body = document.createElement("div");
    body.innerHTML = '<span class="t"></span><span class="a"></span>';
    body.querySelector(".t").textContent = t.title + (t.version ? ` (${t.version})` : "");
    kit.artists(body.querySelector(".a"), t);
    li.append(kit.image(W.cover(t, 100)), body);
    if (time) { const s = document.createElement("span"); s.className = "qtime"; s.textContent = time; li.append(s); }
    // лайк прямо в строке — не включая трек (кнопку и её состояние даёт приложение: kit.likeButton)
    const lb = kit.likeButton?.(t);
    if (lb) li.append(lb);
    if (remove) {
      const x = document.createElement("button");
      x.className = "qx"; x.title = "Убрать из очереди"; x.innerHTML = IC.x;
      x.onclick = (e) => { e.stopPropagation(); remove(); };
      li.append(x);
    }
    if (more && kit.trackMenu) {
      const mb = document.createElement("button");
      mb.className = "morebtn"; mb.title = "Ещё"; mb.innerHTML = kit.icon("more");
      mb.onclick = (e) => { e.stopPropagation(); kit.trackMenu(t, mb); };
      li.append(mb);
    }
    if (onClick) li.onclick = onClick;
    kit.decorateRow(li, t, li.querySelector(".qtime, .likebtn, .qx, .morebtn"));      // свои значки приложения — перед кнопками строки
    return li;
  }

  const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate(); };
  function dayLabel(ms) {
    const now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
    if (dayKey(ms) === dayKey(+now)) return "Сегодня";
    if (dayKey(ms) === dayKey(+y)) return "Вчера";
    const d = new Date(ms);
    return d.toLocaleDateString("ru-RU", d.getFullYear() === now.getFullYear() ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" });
  }
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  const hhmm = (ms) => new Date(ms).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

  function removeAt(i) {
    const t = W.queue.remove(i);
    if (t) kit.toast(`«${t.title}» убран из очереди`, 4000, { action: { label: "Вернуть", fn: () => W.queue.playNext(t, { quiet: true }) } });
  }

  function render() {
    if (panel.hidden) return;
    if (dragging) { pending = true; return; }
    const keepScroll = el(".qbody").scrollTop;
    const ps = W.player.state();
    // сейчас играет
    const now = el(".qnow"); now.innerHTML = "";
    const cur = ps.track;
    if (cur) now.append(row(cur, { onClick: () => W.player.toggle() }));
    // далее
    const list = el(".qnext"); list.innerHTML = "";
    const total = W.queue.upcomingCount();
    const next = W.queue.upcoming(longNext ? NEXT_LONG : NEXT_SHORT);
    next.forEach(({ index, track }, pos) => {
      list.append(row(track, {
        onClick: () => W.queue.playAt(index),
        grip: gripFor(pos),
        remove: () => removeAt(index),
      }));
    });
    el(".qsrc").textContent = W.queue.label();
    el(".qnextempty").hidden = next.length > 0;
    el(".qnextempty").textContent = !cur ? "Ничего не играет."
      : ps.context?.type === "radio" ? `${cap(W.queue.label() || "поток")} подбирает следующие треки…`
      : ps.modes.repeat === 1 ? "Дальше список начнётся сначала."
      : "Это последний трек в очереди.";
    const mb = el(".qmore");
    mb.hidden = total <= NEXT_SHORT;
    mb.textContent = longNext ? "Свернуть" : `Показать ещё (${Math.min(total, NEXT_LONG) - NEXT_SHORT})`;
    // история
    const box = el(".qhist"); box.innerHTML = "";
    let ul = null, lastDay = -1;
    hist.forEach((h, i) => {
      const k = dayKey(h.at);
      if (k !== lastDay) {
        lastDay = k;
        const d = document.createElement("div"); d.className = "qday"; d.textContent = dayLabel(h.at);
        ul = document.createElement("ul"); ul.className = "list qhlist";
        box.append(d, ul);
      }
      ul.append(row(W.to("track", h.t), { time: hhmm(h.at), onClick: () => playFromHistory(i) }));
    });
    el(".qhistempty").hidden = hist.length > 0;
    el(".qclear").hidden = !hist.length;
    el(".qbody").scrollTop = keepScroll;
  }
  let rafId = 0;
  function refresh() {
    if (panel.hidden || rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; render(); });
  }
  // очередь, трек, режимы повтора/перемешивания (меняют порядок «Далее») — от ядра
  for (const ev of ["queue", "track", "modes"]) W.on(ev, refresh);

  // Трек из истории: играет он, а дальше — то, что слушалось до него.
  function playFromHistory(i) { W.queue.play(hist.slice(i).map((h) => W.to("track", h.t)), 0); }

  el(".qmore").onclick = () => { longNext = !longNext; render(); };
  el(".qclose").onclick = () => setOpen(false);
  el(".qclear").onclick = async () => {
    const ok = await kit.confirm({ title: "Очистить историю?", text: "Список прослушанных треков будет удалён. Очередь не изменится.", ok: "Очистить", danger: true });
    if (!ok) return;
    hist.length = 0; saveHist(); render();
  };

  // ---------- перетаскивание в «Далее» ----------
  function gripFor(pos) {
    const g = document.createElement("span");
    g.className = "grip"; g.title = "Перетащи, чтобы изменить порядок"; g.innerHTML = kit.icon("grip");
    g.onclick = (e) => e.stopPropagation();
    g.onpointerdown = (e) => dragStart(e, g.parentElement, pos);
    return g;
  }
  function dragStart(e, li, from) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    kit.closeMenu();
    const rows = [...el(".qnext").children], scroller = el(".qbody");
    let slot = from, lastY = e.clientY, raf = 0, done = false;
    dragging = true;
    li.classList.add("dragging"); document.body.classList.add("pl-drag");
    const mark = () => {
      rows.forEach((r) => r.classList.remove("drop-before", "drop-after"));
      if (slot === from || slot === from + 1) return;
      if (slot < rows.length) rows[slot].classList.add("drop-before"); else rows[rows.length - 1].classList.add("drop-after");
    };
    const compute = () => {
      slot = rows.length;
      for (let k = 0; k < rows.length; k++) { const r = rows[k].getBoundingClientRect(); if (lastY < r.top + r.height / 2) { slot = k; break; } }
      mark();
    };
    const tick = () => {
      const r = scroller.getBoundingClientRect(), edge = 40;
      const dy = lastY < r.top + edge ? -10 : lastY > r.bottom - edge ? 10 : 0;
      if (dy) { scroller.scrollTop += dy; compute(); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const move = (ev) => { lastY = ev.clientY; compute(); };
    const finish = (apply) => {
      if (done) return; done = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", key, true);
      rows.forEach((r) => r.classList.remove("drop-before", "drop-after"));
      li.classList.remove("dragging"); document.body.classList.remove("pl-drag");
      dragging = false;
      const to = slot > from ? slot - 1 : slot;
      if (apply && to !== from) W.queue.move(from, to);
      else if (pending) render();
      pending = false;
    };
    const up = () => finish(true), cancel = () => finish(false);
    const key = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); finish(false); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", key, true);
  }

  // ---------- открыть / закрыть ----------
  // Панель занимает правую часть между верхом средней области и плеером — плеер остаётся под рукой.
  function place() {
    const main = roleEl("main"), pl = roleEl("player");
    const m = main ? main.getBoundingClientRect() : { top: 0, right: innerWidth };
    const pTop = pl ? pl.getBoundingClientRect().top : innerHeight;
    panel.style.top = Math.round(m.top) + "px";
    panel.style.bottom = Math.round(innerHeight - pTop + 12) + "px";
    panel.style.right = Math.round(innerWidth - m.right) + "px";
  }
  function setOpen(on) {
    if (on === !panel.hidden) return;
    panel.hidden = !on;
    document.querySelectorAll(".qtoggle").forEach((b) => b.classList.toggle("on", on));
    if (on) { longNext = false; place(); render(); el(".qbody").scrollTop = 0; }
  }
  const toggle = () => setOpen(panel.hidden);
  window.qToggle = toggle;
  window.addEventListener("resize", () => { if (!panel.hidden) place(); });

  // кнопка в плеере — перед громкостью (нет громкости — в конец правого блока плеера); видна на любой странице
  const pBtn = document.createElement("button");
  pBtn.id = "qBtn"; pBtn.className = "qtoggle"; pBtn.title = "Очередь и история прослушивания (Q)";
  pBtn.setAttribute("aria-label", "Очередь и история прослушивания"); pBtn.innerHTML = IC.queue;
  pBtn.onclick = (e) => { e.stopPropagation(); toggle(); };
  const vol = roleEl("player.volume");
  if (vol) vol.before(pBtn); else (roleEl("player.actions") || roleEl("player"))?.append(pBtn);

  // подписанная кнопка — сразу под выбором станций потока (у Whisper Yandex — под «Жанрами и настроениями» Моей волны)
  const st = roleEl("radio.stations");
  if (st) {
    const wBtn = document.createElement("button");
    wBtn.id = "waveQBtn"; wBtn.className = "nav qwavebtn qtoggle"; wBtn.title = "Очередь и история прослушивания (Q)";
    wBtn.innerHTML = IC.history + "<span>История прослушивания</span>";
    wBtn.onclick = (e) => { e.stopPropagation(); toggle(); };
    st.after(wBtn);
  }

  // щелчок мимо панели закрывает её; плеер, меню трека, окна, подсказки и заголовок окна — не считаются
  document.addEventListener("pointerdown", (e) => {
    if (panel.hidden) return;
    const t = e.target;
    if (panel.contains(t) || t.closest?.(".qtoggle") || inRole(t, "menu", "player", "dialog", "dialog.backdrop", "toast", "titlebar")) return;
    setOpen(false);
  }, true);
  const anyShown = (role) => W.ui.all(role).some((x) => !x.hidden);
  document.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea, [contenteditable]")) return;
    if (e.key === "Escape" && !panel.hidden && !anyShown("dialog.backdrop")) setOpen(false);
    else if (e.code === "KeyQ" && !e.ctrlKey && !e.metaKey && !e.altKey && !anyShown("fullplayer") && !anyShown("visualizer:fullscreen")) toggle();
  });
})();
