// Локальная API приложений Whisper (docs/API.md): программы Whisper на одном компьютере управляют друг другом —
// например, микшер ставит одну тему сразу во все клиенты. Rust — rust/api.rs ядра (сервер на 127.0.0.1 + реестр).
// ОБЩИЙ модуль ядра, но работает и без whisper-core.js (Whisper Mixer): тогда программа сама регистрирует
// обработчики (WhisperApi.handle) и включает API (WhisperApi.start({ id, name, version })).
// С ядром всё само: id и название — из Whisper.app, обработчики тем — из набора интерфейса (kit.themeImport /
// kit.themeExport, те же, что у «Тем комнаты»), карточка «Приложения Whisper» — в настройках (kit.settingsCard).
(() => {
  const T = window.__TAURI__;
  if (!T?.core || !T?.event || window.WhisperApi) return;
  const W = window.Whisper || null;
  const invoke = (c, a, o) => Promise.resolve(T.core.invoke(c, a, o));
  const enc = new TextEncoder(), dec = new TextDecoder();
  // как cap_ok в rust/api.rs: «GET theme», «POST theme», «GET theme/file»
  const capOk = (c) => /^(GET|POST) [a-z0-9._\/-]{1,64}$/.test(c) && !/ \/|\/$|\/\/|\.\./.test(c);
  const handlers = new Map();      // «POST theme» -> async (req) => ответ
  const KEY = (W?.app?.storage || "whisper_") + "api";
  let on = true;
  try { on = localStorage.getItem(KEY) !== "off"; } catch {}
  let info = null, running = false, listening = null, again = 0, lastErr = "";
  const changed = new Set();       // кому сообщить, что API включили/выключили (карточка настроек)

  const toBytes = (b) =>
    b instanceof Uint8Array ? b
      : b instanceof ArrayBuffer ? new Uint8Array(b)
      : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
      : null;
  // свой код ответа: return WhisperApi.reply(409, { ok: false, error: "…" })
  const MARK = Symbol("wapi-reply");
  const reply = (status, json) => Object.freeze({ [MARK]: true, status, json });

  async function answer(id, status, body, type = "json") {
    const bytes = type === "json" ? enc.encode(JSON.stringify(body ?? null)) : body;
    try { await invoke("wapi_reply", bytes, { headers: { "x-wapi-id": String(id), "x-wapi-status": String(status), "x-wapi-type": type } }); }
    catch (e) { console.warn("[api] ответ не отправлен:", e); }
  }
  async function dispatch(p) {
    const id = Number(p?.id), cap = String(p?.cap || ""), fn = handlers.get(cap);
    if (!id) return;
    if (!fn) return answer(id, 404, { ok: false, error: "приложение этого не умеет" });
    let body = null;
    const req = {
      cap,
      query: new URLSearchParams(String(p.query || "")),
      size: Number(p.size) || 0,
      body: async () => body || (body = new Uint8Array(await invoke("wapi_body", { id }))),
      json: async () => { const t = dec.decode(await req.body()); return t ? JSON.parse(t) : null; },
    };
    try {
      const r = await fn(req);
      if (r && r[MARK]) return answer(id, r.status, r.json ?? { ok: r.status < 400 });
      const bytes = toBytes(r);
      if (bytes) return answer(id, 200, bytes, "bytes");
      return answer(id, 200, r ?? { ok: true });
    } catch (e) { return answer(id, 500, { ok: false, error: String(e?.message || e) }); }
  }

  async function start(o) {
    if (o) info = { id: String(o.id || ""), name: String(o.name || ""), version: String(o.version || "") };
    if (!info?.id) return false;
    if (!on) { await stop(); return false; }
    listening ||= Promise.resolve(T.event.listen("wapi", (e) => dispatch(e.payload))).catch((e) => { listening = null; throw e; });
    try {
      await listening;
      await invoke("wapi_start", { info: { ...info, caps: [...handlers.keys()] } });
      running = true; lastErr = "";
    } catch (e) { running = false; lastErr = String(e?.message || e); console.warn("[api] не запустилась:", lastErr); }
    changed.forEach((f) => { try { f(); } catch {} });
    return running;
  }
  async function stop() {
    if (running) { try { await invoke("wapi_stop"); } catch {} }
    running = false;
    changed.forEach((f) => { try { f(); } catch {} });
  }
  // новые обработчики — сообщить Rust (и реестру), что приложение теперь умеет
  const restart = () => { clearTimeout(again); again = setTimeout(() => { if (info && on) start(); }, 30); };

  function handle(cap, fn) {
    if (!capOk(cap) || typeof fn !== "function") throw new Error("WhisperApi.handle: неверное действие " + cap);
    handlers.set(cap, fn);
    restart();
  }
  const apps = () => invoke("wapi_apps").then((l) => (Array.isArray(l) ? l : [])).catch(() => []);
  function send(cap, data, { to = [], query = "" } = {}) {
    const bytes = data == null ? new Uint8Array(0) : toBytes(data) || enc.encode(JSON.stringify(data));
    return invoke("wapi_send", bytes, { headers: { "x-wapi-cap": cap, "x-wapi-to": [].concat(to).join(","), "x-wapi-query": query } });
  }
  const fetchFrom = async (app, cap, query = "") => new Uint8Array(await invoke("wapi_fetch", { app, cap, query }));
  const setEnabled = (v) => {
    on = !!v;
    try { localStorage.setItem(KEY, on ? "on" : "off"); } catch {}
    return on ? start() : stop();
  };

  const api = Object.freeze({
    VERSION: 1,
    handle, reply, start, stop, apps, send,
    fetch: fetchFrom,
    /** Тема (.wmt, Uint8Array) — во все запущенные приложения Whisper (или только в o.to: [id…]) */
    sendTheme: (bytes, o) => send("POST theme", bytes, o),
    /** Текущая тема другого приложения файлом .wmt */
    themeOf: (app) => fetchFrom(app, "GET theme/file"),
    enabled: () => on,
    running: () => running,
    error: () => lastErr,
    setEnabled,
    onChange: (f) => { changed.add(f); return () => changed.delete(f); },
  });
  window.WhisperApi = api;
  if (!W) return;

  // ---------- с ядром: темы через набор интерфейса ----------
  W.modules.api = api;
  const kit = W.ui.kit;
  if (kit.themeImport) {
    // тема от другого приложения ставится так же, как «Загрузить тему…»: те же проверки и тот же фильтр безопасности
    handle("POST theme", async (req) => {
      const r = await kit.themeImport(await req.body());
      if (r === true) return { ok: true };
      if (r === null) return reply(409, { ok: false, error: "замену стиля отменили в приложении" });
      return reply(422, { ok: false, error: "тема не применилась — подробности в настройках приложения" });
    });
  }
  if (kit.themeExport) {
    handle("GET theme", async () => {
      const t = await kit.themeExport();
      return t ? { ok: true, id: t.id, name: t.name, author: t.author || "", size: t.bytes?.byteLength || 0 } : reply(404, { ok: false, error: "нет текущего стиля" });
    });
    handle("GET theme/file", async () => {
      const t = await kit.themeExport();
      return t?.bytes ? toBytes(t.bytes) : reply(404, { ok: false, error: "нет текущего стиля" });
    });
  }

  // ---------- карточка в настройках ----------
  const $a = (id) => document.getElementById(id);
  if (kit.settingsCard && !$a("wapiOn")) {
    const card = document.createElement("div");
    card.innerHTML = `
          <h3>Приложения Whisper</h3>
          <label class="switch" title="Микшер и другие клиенты Whisper на этом компьютере могут ставить сюда стиль, а этот стиль — отправляться им"><input type="checkbox" id="wapiOn" /><i></i><span>Связь с приложениями Whisper</span></label>
          <div id="wapiBox">
            <button type="button" class="nav" id="wapiSend"${kit.themeExport ? "" : " hidden"} title="Текущий стиль ставится во все запущенные приложения Whisper">Стиль — во все приложения</button>
            <p id="wapiNote" class="status"></p>
          </div>
        `;
    if (kit.settingsCard(card, { section: "look" }) === false) card.remove();
  }
  const sw = $a("wapiOn");
  if (sw) {
    const box = $a("wapiBox"), note = $a("wapiNote"), btn = $a("wapiSend");
    const say = (t, err) => { note.textContent = t || ""; note.classList.toggle("err", !!err); };
    let busy = false;
    const names = (l) => l.map((a) => a.name || a.id).join(", ");
    const card = sw.closest(".card");
    async function refresh() {
      // в сборке без API (телефон: rust/api.rs только для компьютера) карточка не нужна
      if (card && !running && /not (found|allowed)/i.test(lastErr)) { card.style.display = "none"; return; }
      sw.checked = on;
      box.style.display = on ? "" : "none";
      if (!on || busy) return;
      if (!running && lastErr) return say("Связь не включилась: " + lastErr, true);
      const l = await apps();
      if (!busy) say(l.length ? "Рядом: " + names(l) : "Других приложений Whisper не запущено");
    }
    sw.onchange = () => setEnabled(sw.checked);
    api.onChange(refresh);
    btn.onclick = async () => {
      if (busy) return;
      busy = true; btn.disabled = true; say("Стиль отправляется…");
      try {
        const t = await kit.themeExport();
        if (!t?.bytes) throw new Error("нет текущего стиля");
        const res = await api.sendTheme(toBytes(t.bytes));
        const ok = res.filter((r) => r.ok), bad = res.filter((r) => !r.ok);
        if (!res.length) say("Других приложений Whisper, принимающих стили, не запущено");
        else {
          const parts = [];
          if (ok.length) parts.push(`Стиль «${t.name}» применён: ${names(ok)}`);
          if (bad.length) parts.push("не применился: " + bad.map((r) => `${r.name || r.id} (${r.error || "ошибка " + r.status})`).join(", "));
          say(parts.join("; ") + ".", !ok.length);
          if (ok.length) kit.toast?.(`Стиль применён в ${ok.length === 1 ? ok[0].name : ok.length + " приложениях"}`, 3000, { kind: "ok" });
        }
      } catch (e) { say("Стиль не отправлен: " + (e?.message || e), true); }
      busy = false; btn.disabled = false;
    };
    // список соседей — каждый раз, когда карточку видно (открыли настройки)
    if ("IntersectionObserver" in window) new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) refresh(); }).observe(card || box);
    refresh();
  }

  // версия программы — для /v1/info (у Whisper Yandex в setApp её нет)
  (async () => {
    let version = W.app.version;
    if (!version) { try { version = (await T.app?.getVersion?.()) || ""; } catch {} }
    start({ id: W.app.id, name: W.app.name || W.app.id, version });
  })();
})();
