"use strict";
// Whisper Embed — темы .wmt в ЛЮБОМ веб-приложении одним вызовом (docs/EMBED.md). Для независимых авторов:
// своё приложение (Electron, Tauri, обёртка над сайтом, обычная страница) с другим интерфейсом и без theme.js Whisper.
//
//   const t = await WhisperEmbed.applyTheme(bytes, { app: "my-player", map: { "color.accent": "--brand" } });
//   t.coverage   // { ratio: 0.8, missing: ["player.volume"] } — насколько тема подходит этому приложению
//   t.remove()   // снять тему
//
// Нужны core/wmt.js и core/theme-css.js (подключить раньше). core/whisper-core.js — по желанию: с ним работают роли
// [data-w="…"] (Whisper.ui.define) и карта токенов приложения (Whisper.ui.tokens); без него — только секция
// приложения и tokens (правила с ролями выбрасываются).
// CSS ставится через adoptedStyleSheets — проходит строгий CSP без 'unsafe-inline' (как DynCss в Whisper Yandex).
(function (root) {
  const slots = new Map();            // имя слота -> { sheet | link, urls, id }
  const need = () => {
    const WMT = root.WMT, TC = root.WhisperThemeCss;
    if (!WMT || !TC) throw new Error("WhisperEmbed: подключи core/wmt.js и core/theme-css.js раньше embed.js");
    return { WMT, TC, W: root.Whisper || null };
  };
  const open = async (input) => (input && typeof input.css === "function" && input.manifest ? input : need().WMT.open(input));

  // CSS в документ: конструируемая таблица (CSP не мешает) или, в старых движках, <link> на blob:
  function install(doc, css, prev) {
    if (prev) uninstall(doc, prev);
    if ("adoptedStyleSheets" in doc && typeof CSSStyleSheet === "function") {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
        return { sheet, urls: [] };
      } catch {}
    }
    const url = URL.createObjectURL(new Blob([css], { type: "text/css" })), link = doc.createElement("link");
    link.rel = "stylesheet"; link.href = url;
    doc.head.appendChild(link);
    return { link, urls: [url] };
  }
  function uninstall(doc, s) {
    if (s.sheet) doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((x) => x !== s.sheet);
    s.link?.remove();
    for (const u of s.urls || []) URL.revokeObjectURL(u);
  }

  // Что в теме для этого приложения — не применяя её (для списка тем: «подходит на 80%»).
  async function inspect(input, opts = {}) {
    const { TC, W } = need(), th = await open(input), app = opts.app || W?.app?.id || "";
    const roles = TC.rolesUsed(th, app);
    return {
      theme: th, manifest: th.manifest, tokens: th.tokens,
      hasCore: !!(th.css(TC.CORE) || "").trim(), hasApp: !!(app && (th.css(app) || "").trim()),
      roles, coverage: W?.ui?.coverage ? W.ui.coverage(roles) : { used: roles, have: [], missing: roles, ratio: roles.length ? 0 : 1 },
      background: th.background ? { name: th.background.name, mime: th.background.mime } : null,
    };
  }

  /**
   * Применить тему. input — байты файла (.wmt текст или архив), строка или уже открытая тема (WMT.open).
   * opts:
   *   app        — id приложения = имя секции «@@ css <app>» (по умолчанию Whisper.app.id);
   *   map        — карта tokens (WhisperThemeCss.tokensMapCss); по умолчанию Whisper.ui.tokenMap(), иначе переменные Whisper;
   *   slot       — имя места (по умолчанию "theme"): новая тема в том же слоте заменяет прежнюю;
   *   root       — элемент <html> (по умолчанию document.documentElement): на нём data-style и data-anim;
   *   anim       — true | false — анимации темы (data-anim="on|off"); не задано — не трогать, если уже стоит;
   *   background — элемент или селектор, куда поставить картинку фона темы (background-image); видео — сами по bg.url;
   *   extra      — свой CSS после tokens (как opts.extra в themeCss).
   * Возвращает { id, manifest, coverage, roles, bg: { url, mime } | null, remove() }.
   */
  async function applyTheme(input, opts = {}) {
    const { TC, W } = need(), th = await open(input);
    const rootEl = opts.root || document.documentElement, doc = rootEl.ownerDocument || document;
    const app = opts.app || W?.app?.id || "", id = th.manifest.id, slot = String(opts.slot || "theme");
    const map = opts.map || W?.ui?.tokenMap?.() || true;
    const { css, urls } = TC.themeCss(th, id, app, { tokenMap: map, extra: opts.extra || "" });
    const prev = slots.get(slot);
    const st = install(doc, css, prev);
    st.urls.push(...urls);
    // фон темы: blob-адрес живёт, пока тема стоит
    let bg = null;
    if (th.background) {
      const u = URL.createObjectURL(new Blob([th.background.bytes], { type: th.background.mime }));
      st.urls.push(u);
      bg = { url: u, mime: th.background.mime };
      const el = typeof opts.background === "string" ? doc.querySelector(opts.background) : opts.background;
      if (el && /^image\//.test(bg.mime)) { el.style.backgroundImage = `url("${u}")`; st.bgEl = el; }
    }
    rootEl.setAttribute("data-style", id);
    if (opts.anim !== undefined || !rootEl.hasAttribute("data-anim")) rootEl.setAttribute("data-anim", opts.anim === false ? "off" : "on");
    st.id = id; st.root = rootEl;
    slots.set(slot, st);
    const roles = TC.rolesUsed(th, app);
    const res = {
      id, manifest: th.manifest, roles, bg,
      coverage: W?.ui?.coverage ? W.ui.coverage(roles) : { used: roles, have: [], missing: roles, ratio: roles.length ? 0 : 1 },
      remove: () => remove(slot),
    };
    W?.emit?.("theme", { id, app, coverage: res.coverage });
    return res;
  }
  function remove(slot = "theme") {
    const st = slots.get(slot);
    if (!st) return false;
    const doc = st.root?.ownerDocument || document;
    uninstall(doc, st);
    if (st.bgEl) st.bgEl.style.backgroundImage = "";
    if (st.root?.getAttribute("data-style") === st.id) st.root.removeAttribute("data-style");
    slots.delete(slot);
    return true;
  }

  const api = Object.freeze({ VERSION: "0.2.0", applyTheme, inspect, remove, current: (slot = "theme") => slots.get(slot)?.id || "" });
  root.WhisperEmbed = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
