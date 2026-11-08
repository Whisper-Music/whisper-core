// Discord Rich Presence: показывает в профиле Discord, что сейчас играет. ОБЩИЙ модуль ядра Whisper
// (docs/CORE.md, «Общие модули»): работает только через Whisper.* — «что играет» и состояние файла
// (Whisper.player.state / media), карточка настроек — Whisper.ui.kit.settingsCard.
// Подключением занимается Rust (rust/discord.rs ядра): сам находит запущенный Discord,
// переподключается после его перезапуска и следит за лимитами. Здесь — переключатель в настройках,
// окно «Discord» (статус подключения, превью, параметры отображения) и «что играет».
(() => {
  const W = window.Whisper;
  if (!W) return;
  const kit = W.ui.kit;
  const KEY = W.app.storage + "discord";       // у Whisper Yandex — ym_discord, как и раньше
  const $d = (id) => document.getElementById(id);
  const DEF = { enabled: false, cover: true, button: true, showPaused: true, titleStatus: true };
  let dc = { ...DEF };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "1") dc.enabled = true;                                   // старый формат — просто «вкл»
    else if (raw) { const v = JSON.parse(raw); for (const k of Object.keys(DEF)) if (typeof v?.[k] === typeof DEF[k]) dc[k] = v[k]; }
  } catch {}
  let st = { state: "off", user: null };
  let started = false, last = "";

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(dc)); } catch {} };
  const call = (cmd, args) => Promise.resolve(window.__TAURI__.core.invoke(cmd, args));

  // ---------- что играет ----------
  // «Играет» — не просто audio.paused === false: плеер может стоять на загрузке, буферизации или после ошибки
  // сети, а paused при этом остаётся false — и Discord продолжал показывать бегущее время. Поэтому раз в секунду
  // проверяем, что позиция действительно движется; если стоит дольше STUCK_MS — сообщаем «пауза».
  const STUCK_MS = 2500, DRIFT_MS = 3000;
  let stuck = false, stuckSince = 0, lastCt = -1;
  let sent = null, sentAt = 0;            // что и когда ушло в Discord — для проверки расхождения времени
  // файл приложения: идёт ли он на самом деле (не пауза, не конец, не ошибка) — Whisper.player.media()
  const media = () => W.player.media();
  const nominal = () => { const m = media(); return m.has !== false && !m.paused && !m.ended && !m.error; };
  const isPlaying = () => nominal() && !stuck;

  // трек — из ядра Whisper (общая сущность Track); время и «не завис ли плеер» — по файлу (Whisper.player.media)
  function snapshot() {
    const p = W.player.state(), t = p.track, m = media();
    if (!t || !started || m.has === false) return null;
    const al = t.album;
    // Discord отсчитывает время по обычным часам, поэтому при скорости ≠ 1× длительность и позиция
    // пересчитываются в «настоящие» секунды: полоска и время окончания совпадают с тем, что слышно.
    const r = m.rate > 0 ? m.rate : 1;
    const dur = m.duration > 0 ? m.duration * 1000 : t.durationMs || 0;
    return {
      id: t.id,
      title: t.title || "Без названия",
      artist: t.artists.map((a) => a.name).filter(Boolean).join(", "),
      album: al?.title || "",
      albumId: al?.id || "",
      cover: W.cover(t, 400),
      durationMs: Math.round(dur / r),
      positionMs: Math.round(((m.time || 0) * 1000) / r),
      playing: isPlaying(),
      mode: mode(),
    };
  }
  // что человек сейчас делает, кроме «слушает»: комната (core/together.js) главнее режима сна (kit.sleeping от приложения)
  function mode() {
    if (window.roomInfo?.()) return "together";
    if (kit.sleeping?.()) return "sleep";
    return "";
  }
  const MODE_TEXT = { together: "Слушает вместе", sleep: "Засыпает" };
  // смена трека, пауза/воспроизведение, перемотка, скорость — от ядра (Whisper.player.watch)
  function push(force) {
    const m = media();
    if (m.has !== false && !m.paused) started = true;
    if (!dc.enabled) return;
    const s = snapshot();
    const key = s ? JSON.stringify({ ...s, positionMs: 0 }) : "";       // позиция меняется всегда — сравниваем без неё
    if (!force && key === last) return;
    last = key;
    sent = s; sentAt = Date.now();
    call("discord_update", { track: s }).catch(() => {});
  }
  W.player.watch(push);
  window.discordPush = push;           // для совместимости: кто-то снаружи может попросить отправить заново

  // Страховка от пропущенных событий: зависание/буферизация, ошибка загрузки, смена плеера,
  // а также расхождение времени (трек долго грузился, система «спала») — всё это ловится здесь.
  setInterval(() => {
    if (!dc.enabled || !started) return;
    const now = Date.now();
    const m = media(), ct = m.time || 0;
    let s = false;
    if (nominal() && (ct === lastCt || m.buffering)) {
      if (!stuckSince) stuckSince = now;
      s = now - stuckSince >= STUCK_MS;
    } else stuckSince = 0;
    lastCt = ct;
    if (s !== stuck) { stuck = s; push(true); return; }
    const cur = snapshot();
    if (!cur) { if (sent) push(true); return; }
    if (!sent || cur.playing !== sent.playing || cur.id !== sent.id || cur.mode !== sent.mode) { push(true); return; }
    if (cur.playing) {
      const expected = sent.positionMs + (now - sentAt);
      if (Math.abs(cur.positionMs - expected) > DRIFT_MS) push(true);
    }
  }, 1000);

  // ---------- подключение ----------
  async function apply() {
    try { st = await call("discord_config", { cfg: dc }); } catch {}
    paint();
    if (dc.enabled) { last = ""; push(true); }
  }
  function set(patch) { Object.assign(dc, patch); save(); apply(); }

  const TEXT = {
    off:   ["Выключено", ""],
    on:    ["Подключено", "Статус обновляется сам"],
    wait:  ["Discord не запущен", "Подключение произойдёт автоматически, когда Discord откроется"],
    badid: ["Discord не принял подключение", "Попробуй перезапустить Discord"],
  };
  const label = () => (st.state === "on" && st.user?.name ? `Подключено: ${st.user.name}` : TEXT[st.state]?.[0] || "");

  function paint() {
    const sw = $d("dcOn"); if (sw) sw.checked = dc.enabled;
    const dot = $d("dcDot"); if (dot) dot.dataset.s = dc.enabled ? st.state : "off";
    const n = $d("dcNote"); if (n) n.textContent = dc.enabled ? label() : "Выключено";
    paintModal();
  }

  window.__TAURI__.event?.listen("discord-status", (e) => { if (e.payload && typeof e.payload === "object") { st = e.payload; paint(); } });

  // ---------- окно ----------
  let m = null, tick = 0;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  function sw(text, tip, key) {
    const l = el("label", "switch"); l.title = tip;
    const i = el("input"); i.type = "checkbox"; i.checked = !!dc[key];
    i.onchange = () => set({ [key]: i.checked });
    l.append(i, el("i"), el("span", "", text));
    return l;
  }

  function openModal() {
    if (m) return;
    const wrap = el("div", "login modal");
    const box = el("div", "panel login-box modalbox dcmodal");

    // шапка: аккаунт и состояние
    const acc = el("div", "dcacc");
    const ava = el("div", "dcava"); const img = el("img"); img.alt = ""; ava.append(img);
    const who = el("div", "dcwho"); const wt = el("b"), ws = el("small"); who.append(wt, ws);
    const retry = el("button", "nav", "Повторить"); retry.type = "button";
    retry.onclick = () => { call("discord_retry").catch(() => {}); retry.disabled = true; setTimeout(() => (retry.disabled = false), 2000); };
    const main = el("label", "switch dcmain"); const mi = el("input"); mi.type = "checkbox";
    mi.onchange = () => set({ enabled: mi.checked });
    main.title = "Использовать Discord RPC"; main.append(mi, el("i"));
    acc.append(ava, who, retry, main);

    // превью — как это увидят в Discord
    const prev = el("div", "dcprev");
    const ph = el("small", "dcph", "Слушает");
    const pr = el("div", "dcprow");
    const pc = el("img", "dcpcov"); pc.alt = "";
    const pt = el("div", "dcptxt"); const p1 = el("b"), p2 = el("span"), p3 = el("span", "dcpalb"); pt.append(p1, p2, p3);
    pr.append(pc, pt);
    const bar = el("div", "dcbar"); const t1 = el("small"), tr = el("div", "dctrack"), fillEl = el("i"), t2 = el("small"); tr.append(fillEl); bar.append(t1, tr, t2);
    const pbtn = el("div", "dcpbtn", "Скачать Whisper");
    const empty = el("p", "dcempty", "Включи любой трек — здесь появится превью");
    prev.append(ph, pr, bar, pbtn, empty);

    // параметры
    const opts = el("div", "dcopts");
    opts.append(
      sw("Обложка трека", "Обложка альбома рядом со статусом", "cover"),
      sw("Кнопка «Скачать Whisper»", "В профиле появится кнопка со ссылкой на GitHub, где можно скачать этот клиент", "button"),
      sw("Показывать на паузе", "Иначе статус пропадает, пока музыка на паузе", "showPaused"),
      sw("Название трека в списке участников", "Вместо названия приложения рядом с ником будет название трека", "titleStatus"),
    );

    const foot = el("div", "row");
    const done = el("button", "nav active", "Готово"); done.type = "button";
    foot.append(done);

    box.append(el("h2", "", "Discord"), acc, prev, opts, foot);
    wrap.append(box); document.body.append(wrap);

    const close = () => { document.removeEventListener("keydown", onKey, true); clearInterval(tick); wrap.remove(); m = null; };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("keydown", onKey, true);
    done.onclick = close;
    wrap.onpointerdown = (e) => { if (e.target === wrap) close(); };

    m = { img, ava, wt, ws, retry, mi, prev, pc, p1, p2, p3, bar, t1, t2, fillEl, pbtn, empty, opts };
    paintModal();
    tick = setInterval(paintPreview, 1000);
  }

  function paintModal() {
    if (!m) return;
    const s = dc.enabled ? st.state : "off";
    m.mi.checked = dc.enabled;
    m.ava.dataset.s = s;
    const av = s === "on" && st.user?.avatar ? st.user.avatar : "";
    if (m.img.getAttribute("src") !== av) { if (av) m.img.src = av; else m.img.removeAttribute("src"); }
    m.wt.textContent = dc.enabled ? label() : "Выключено";
    m.ws.textContent = dc.enabled ? TEXT[s]?.[1] || "" : "Включи переключатель справа";
    m.retry.hidden = !(dc.enabled && (s === "wait" || s === "badid"));
    m.opts.classList.toggle("dim", !dc.enabled);
    paintPreview();
  }

  function paintPreview() {
    if (!m) return;
    const t = W.player.state().track, mm = media();
    const show = !!t;
    for (const x of [m.prev.querySelector(".dcph"), m.prev.querySelector(".dcprow"), m.bar, m.pbtn]) x.hidden = !show;
    m.empty.hidden = show;
    if (!show) return;
    const playing = isPlaying();
    const hiddenOnPause = !playing && !dc.showPaused;
    m.prev.classList.toggle("off", hiddenOnPause || !dc.enabled);
    m.prev.title = hiddenOnPause ? "На паузе статус не показывается" : "";
    const c = dc.cover ? W.cover(t, 200) : "";
    m.pc.hidden = !c;
    if (c && m.pc.getAttribute("src") !== c) m.pc.src = c;
    const title = t.title || "Без названия";
    m.p1.textContent = playing ? title : "⏸ " + title;
    const artist = t.artists.map((a) => a.name).filter(Boolean).join(", ") || "Неизвестный исполнитель";
    const md = MODE_TEXT[mode()];
    m.p2.textContent = !playing ? "На паузе · " + artist : md ? md + " · " + artist : artist;
    m.p3.textContent = t.album?.title || "";
    m.p3.hidden = !dc.cover || !m.p3.textContent;
    const dur = mm.duration > 0 ? mm.duration * 1000 : t.durationMs || 0;
    const pos = (mm.time || 0) * 1000;
    m.bar.hidden = !playing || !dur;
    m.t1.textContent = fmt(pos); m.t2.textContent = fmt(dur);
    m.fillEl.style.width = dur ? Math.min(100, (pos / dur) * 100) + "%" : "0";
    m.pbtn.hidden = !dc.button;
  }

  // ---------- карточка в настройках ----------
  // куда встать, решает приложение (kit.settingsCard): у Whisper Yandex — «Интеграции», первой в правом столбце
  if (!$d("dcOn") && kit.settingsCard) {
    const card = document.createElement("div");
    card.innerHTML = `
          <h3>Discord</h3>
          <label class="switch" title="Показывает в профиле Discord, что сейчас играет. Подключается само, когда Discord запущен"><input type="checkbox" id="dcOn" /><i></i><span>Использовать Discord RPC</span></label>
          <div class="dcline">
            <span class="dcdot" id="dcDot"></span>
            <span class="dcnote" id="dcNote">Выключено</span>
            <button class="nav" id="dcSetup">Настроить…</button>
          </div>
        `;
    kit.settingsCard(card, { section: "integrations", colbreak: true });
  }
  const swEl = $d("dcOn");
  if (swEl) swEl.onchange = (e) => set({ enabled: e.target.checked });
  const setup = $d("dcSetup"); if (setup) setup.onclick = openModal;

  call("discord_status").then((s) => { if (s) st = s; paint(); }).catch(() => paint());
  if (dc.enabled) apply();
})();
