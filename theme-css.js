"use strict";
// Whisper Core: движок CSS тем .wmt — общий для всех приложений Whisper (Yandex, VK…). Формат файла — core/wmt.js.
// Модуль из чистых функций, без DOM и без зависимостей от приложения: работает в браузере и в Node 18+
// (так его можно проверять тестами и собирать темы скриптами). В браузере — window.WhisperThemeCss.
//
// Что здесь:
// * scopeCss — привязка правил темы к своему стилю (:root[data-style="<id>"] …) плюс фильтр безопасности (cssSafe):
//   тема не ходит в сеть, не подменяет анимации, шрифты и слои приложения; роли [data-w="…"] → селекторы приложения;
// * extractFrom — обратная операция: правила встроенного стиля из CSS приложения уже без привязки («Сохранить в файл»);
// * tokensCss, cssVal — значения из @@ tokens; withAssets — url(asset:…) → blob:; obsCss — секция виджета OBS.
//
// Соглашения, на которые опирается привязка (их должно соблюдать приложение):
// * стиль выбирается атрибутом data-style на <html>, анимации — data-anim="on|off" там же;
// * слой выключения анимаций приложения называется не с «wmt-» (слои, @keyframes и @font-face темы получают префикс wmt-<id>-).
(function (root) {
  // ---------- CSS: привязка правил к стилю и обратно ----------
  // разделить список селекторов по запятым верхнего уровня (запятые внутри :is(), [attr="a,b"] не в счёт)
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
  // Разбор CSS-текста на правила. Браузерный разбор (CSSOM) здесь не годится: при пересборке он теряет
  // сокращённые свойства с var() (например, «background: linear-gradient(… var(--x) …)» превращается в пустоту).
  // Поэтому тексты правил переносятся как есть — с исходным форматированием и комментариями внутри.
  function cssParse(src) {
    const nodes = [], n = src.length;
    let i = 0;
    const endStr = (k) => { const q = src[k++]; while (k < n && src[k] !== q) { if (src[k] === "\\") k++; k++; } return k + 1; };
    const endCmt = (k) => { const e = src.indexOf("*/", k + 2); return e < 0 ? n : e + 2; };
    const skipWs = () => { for (;;) { while (i < n && /\s/.test(src[i])) i++; if (src.startsWith("/*", i)) i = endCmt(i); else break; } };
    const readPrelude = () => {
      let s = "", depth = 0;
      while (i < n) {
        const c = src[i];
        if (c === '"' || c === "'") { const j = endStr(i); s += src.slice(i, j); i = j; continue; }
        if (src.startsWith("/*", i)) { i = endCmt(i); s += " "; continue; }
        if (c === "(" || c === "[") depth++; else if (c === ")" || c === "]") depth--;
        if (depth <= 0 && (c === "{" || c === ";" || c === "}")) break;
        s += c; i++;
      }
      return s.trim().replace(/\s+/g, " ");
    };
    const readBlock = () => {
      const start = ++i; let depth = 1;
      while (i < n) {
        const c = src[i];
        if (c === '"' || c === "'") { i = endStr(i); continue; }
        if (src.startsWith("/*", i)) { i = endCmt(i); continue; }
        if (c === "{") depth++;
        else if (c === "}" && !--depth) { const body = src.slice(start, i); i++; return body; }
        i++;
      }
      return src.slice(start);
    };
    for (;;) {
      skipWs();
      if (i >= n) break;
      if (src[i] === "}") { i++; continue; }
      const prelude = readPrelude();
      if (i >= n || src[i] === ";") { i++; if (prelude) nodes.push({ prelude, body: null }); continue; }
      if (src[i] === "}") { i++; continue; }
      nodes.push({ prelude, body: readBlock() });
    }
    return nodes;
  }
  const ruleText = (sel, body) => `${sel} {${/\n/.test(body) ? body.replace(/\s+$/, "") + "\n" : " " + body.trim() + " "}}`;

  // Роли интерфейса -> селекторы этого приложения (Whisper.ui.resolve). Селектор с ролью, которой здесь нет, выбрасывается
  // (у другого приложения нет такого элемента — правило просто не нужно). Без ядра роли не к чему привязать — тоже выбрасываются.
  const ROLE_ATTR = /\[\s*data-w\s*[~|^$*]?=/i;
  const roleResolver = (fn) => {
    if (typeof fn === "function") return fn;
    const W = root.Whisper;
    return W?.ui?.resolve ? (sel) => W.ui.resolve(sel) : (sel) => (ROLE_ATTR.test(sel) ? "" : sel);
  };
  // при загрузке: селектор из файла -> селектор своего стиля
  function scopeSel(sel, id, gate = "") {
    const pre = `:root[data-style="${id}"]${gate}`;
    return splitTop(sel).map((s) => {
      const m = /^(:root|html)(?![\w-])/i.exec(s);
      return m ? pre + s.slice(m[0].length) : `${pre} ${s}`;
    }).join(", ");
  }
  // ---------- безопасность CSS темы ----------
  // Тема — чужой файл. Её CSS не должен ни ходить в сеть, ни подменять общие анимации и шрифты приложения.
  // Все проверки делаются по ТЕКСТУ ПОСЛЕ РАСКРЫТИЯ ЭКРАНИРОВАНИЯ и без комментариев: «@\69mport», «u\72l(» и «u/**/rl(»
  // браузер читает так же, как «@import» и «url(», а обычное регулярное выражение их не видит.
  const unesc = (s) => String(s)
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, "")
    .replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?|\\([\s\S])/gi, (m, h, c) => {
      if (!h) return c;
      const n = parseInt(h, 16);
      return !n || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? "�" : String.fromCodePoint(n);
    });
  // top-level разбор по «;» (внутри строк, скобок и вложенных {} не режем)
  function splitDecls(body) {
    const out = []; let cur = "", depth = 0, q = "";
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (q) { cur += c; if (c === "\\") cur += body[++i] ?? ""; else if (c === q) q = ""; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === "/" && body[i + 1] === "*") { const e = body.indexOf("*/", i + 2), j = e < 0 ? body.length : e + 2; cur += body.slice(i, j); i = j - 1; continue; }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
      if (c === ";" && depth === 0) { out.push(cur); cur = ""; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }
  // Можно ли оставить фрагмент CSS: из внешнего мира в нём разрешены только blob:-ссылки на ресурсы этой темы
  // (их ставит inject()), data: и #якоря. Функции, которые принимают адрес строкой (image-set, src…), не допускаются совсем.
  function cssSafe(text, allowed) {
    const t = unesc(text);
    if (/@\s*import\b/i.test(t) || /expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding/i.test(t)) return false;
    if (/(^|[^\w-])(?:-webkit-)?(image-set|cross-fade|element|paint|src)\s*\(/i.test(t)) return false;
    const re = /url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;
    let m;
    while ((m = re.exec(t))) {
      const u = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (!(allowed.has(u) || /^data:/i.test(u) || u.startsWith("#"))) return false;
    }
    // «url» без закрывающей скобки или с неразобранным содержимым
    if (/url\s*\(/i.test(t.replace(re, ""))) return false;
    return true;
  }
  const cleanBody = (body, allowed) => splitDecls(body).filter((d) => cssSafe(d, allowed)).join(";");

  // @keyframes и @font-face темы получают имена с её id: тема не может ни подменить общую анимацию или шрифт приложения,
  // ни повлиять на них, пока выбран другой стиль. Переименовываются только имена, которые тема определяет сама.
  const GROUPING = /^@(media|supports|container|layer|scope|starting-style)\b/i;
  const KEYFRAMES = /^@(-webkit-)?keyframes\s+/i;
  function collectNames(nodes, ctx) {
    for (const { prelude, body } of nodes) {
      if (body === null || prelude[0] !== "@") continue;
      const p = unesc(prelude);
      let m;
      if ((m = KEYFRAMES.exec(p))) ctx.kf.add(p.slice(m[0].length).trim().replace(/^["']|["']$/g, ""));
      else if (/^@font-face\b/i.test(p)) {
        const f = /font-family\s*:\s*([^;}]+)/i.exec(unesc(body));
        if (f) ctx.ff.add(f[1].trim().replace(/^["']|["']$/g, ""));
      } else if (GROUPING.test(p)) collectNames(cssParse(body), ctx);
    }
  }
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function renameIn(text, names, pre) {
    if (!names.size) return text;
    const re = new RegExp(`(?<![\\w-])(${[...names].map(escRe).join("|")})(?![\\w-])`, "g");
    return text.replace(re, pre + "$1");
  }
  const ANIM_PROP = /(^|[\s;{])(-webkit-)?animation(-name)?\s*:/i;
  // сдвиг, поворот и увеличение при наведении/нажатии — тоже анимация интерфейса: такие свойства из правил
  // с :hover/:active выносятся в отдельное правило, которое действует только при включённых анимациях
  const MOVE_PROP = /^\s*(-webkit-)?(transform|translate|scale|rotate)\s*:/i;
  const MOTION_ON = '[data-anim="on"]';
  const FONT_PROP = /(^|[\s;{])(--[\w-]*font[\w-]*|font(-family)?)\s*:/i;
  function renameDecls(body, ctx, pre) {
    return splitDecls(body).map((d) => {
      const u = unesc(d);
      if (ANIM_PROP.test(u)) return renameIn(d, ctx.kf, pre);
      if (FONT_PROP.test(u)) return renameIn(d, ctx.ff, pre);
      return d;
    }).join(";");
  }

  function emitCss(nodes, id, ctx, allowed) {
    const out = [], pre = `wmt-${id}-`;
    for (const { prelude, body } of nodes) {
      if (prelude[0] === "@") {
        const p = unesc(prelude);
        if (body === null) continue;                                                      // @import, @charset, @namespace и любые «@что-то;» без блока
        if (/^@layer\b/i.test(p)) {
          // слои темы получают имена с её id: тема не может ни попасть в слой приложения (app-motion-off в styles.css,
          // им выключаются анимации), ни встать в порядке слоёв перед ним
          const names = p.replace(/^@layer\b/i, "").trim();
          if (names && !/^[\w-]+(\.[\w-]+)*$/.test(names)) continue;
          out.push(`@layer${names ? " " + pre + names : ""} {\n${emitCss(cssParse(body), id, ctx, allowed)}\n}`);
          continue;
        }
        if (GROUPING.test(p)) { out.push(`${prelude} {\n${emitCss(cssParse(body), id, ctx, allowed)}\n}`); continue; }
        if (KEYFRAMES.test(p)) {
          const name = p.replace(KEYFRAMES, "").trim().replace(/^["']|["']$/g, "");
          if (!/^[\w-]+$/.test(name)) continue;
          const frames = cssParse(body).map((f) => ruleText(f.prelude, cleanBody(f.body ?? "", allowed))).join("\n");
          out.push(`@keyframes ${pre}${name} {\n${frames}\n}`);
          continue;
        }
        if (/^@font-face\b/i.test(p)) {
          const clean = cleanBody(body, allowed).replace(/font-family\s*:\s*([^;]+)/i, (m, v) => {
            const n = v.trim().replace(/^["']|["']$/g, "");
            return `font-family: "${pre}${n}"`;
          });
          if (/(^|[;\s])src\s*:/i.test(clean)) out.push(`@font-face {${clean}}`);        // без разрешённого источника шрифта правило бесполезно
          continue;
        }
        continue;                                                                        // @property, @page, @counter-style и прочее — не поддерживаются
      }
      if (prelude && body !== null) {
        const sel = ctx.roles(prelude);
        if (!sel) continue;
        const clean = renameDecls(cleanBody(body, allowed), ctx, pre);
        if (!clean.trim()) continue;
        if (/:(hover|active)\b/i.test(unesc(sel))) {
          const ds = splitDecls(clean), move = ds.filter((d) => MOVE_PROP.test(unesc(d))), rest = ds.filter((d) => !MOVE_PROP.test(unesc(d)));
          if (rest.some((d) => d.trim())) out.push(ruleText(scopeSel(sel, id), rest.join(";")));
          if (move.length) out.push(ruleText(scopeSel(sel, id, MOTION_ON), move.join(";")));
        } else out.push(ruleText(scopeSel(sel, id), clean));
      }
    }
    return out.join("\n");
  }
  // CSS темы -> CSS своего стиля id. allowed — адреса, которые можно оставить в url() (blob:-ресурсы этой темы);
  // opts.resolve — перевод ролей в селекторы приложения (по умолчанию Whisper.ui.resolve, если ядро подключено)
  function scopeCss(src, id, allowed = new Set(), opts = {}) {
    const nodes = cssParse(src), ctx = { kf: new Set(), ff: new Set(), roles: roleResolver(opts.resolve) };
    collectNames(nodes, ctx);
    return emitCss(nodes, id, ctx, allowed);
  }
  // При сохранении встроенного стиля: все его правила из CSS приложения, уже без привязки к стилю.
  // Вместе с ними — общие правила «:root[data-style] …» (для любого стиля): в CSS приложения они стоят между
  // правилами стилей и намеренно перекрывают часть из них. Свой стиль подключается последним, и без них порядок
  // перекрытия поменялся бы (например, другие отступы нижней панели) — а так копия совпадает с оригиналом.
  function extractFrom(src, st, pad = "") {
    const want = new RegExp(`\\[data-style(?:=["']?${st}["']?)?\\]`, "g"), res = [];
    for (const { prelude, body } of cssParse(src)) {
      if (body === null) continue;
      if (prelude[0] === "@") {
        if (!GROUPING.test(prelude)) continue;                          // @keyframes и т.п. остаются общими в приложении
        const inner = extractFrom(body, st, pad + "  ");
        if (inner.length) res.push(`${pad}${prelude} {\n${inner.join("\n\n")}\n${pad}}`);
        continue;
      }
      const parts = splitTop(prelude).filter((s) => { want.lastIndex = 0; return want.test(s); }).map((s) => {
        const x = s.replace(want, "");
        return x.startsWith(":root ") ? x.slice(6).trim() : x;
      });
      if (parts.length) res.push(pad + ruleText(parts.join(",\n" + pad), body));
    }
    return res;
  }

  // ---------- значения из tokens ----------
  // Значение для CSS из чужого файла: без выхода из объявления (; { }), без разметки, url() и expression.
  const cssVal = (v) => (typeof v === "string" && v.length <= 300 && !/[;{}<>\\]|\/\*|url\s*\(|expression/i.test(v) ? v.trim() : "");
  // Общая часть tokens: текст, второстепенный текст и шрифты — переменные стиля; фон окна и шрифт — на body.
  // opts.mutedIn — селектор блоков, где приложение само переопределяет --muted (там цвет темы тоже должен быть главнее).
  function tokensCss(tokens, opts = {}) {
    const c = tokens?.color || {}, f = tokens?.font || {}, root = [], body = [];
    if (cssVal(c.text)) root.push(`--text: ${cssVal(c.text)}`);
    if (cssVal(c.muted)) root.push(`--muted: ${cssVal(c.muted)}`);
    if (cssVal(f.display)) root.push(`--font-display: ${cssVal(f.display)}`);
    if (cssVal(f.body)) body.push(`font-family: ${cssVal(f.body)}`);
    // цвет фона окна заменяет фон целиком (в том числе градиенты основы); своя картинка лежит отдельно, в #bg
    if (cssVal(c.background)) body.push(`background: ${cssVal(c.background)}`);
    const blocks = cssVal(c.muted) && opts.mutedIn ? `${opts.mutedIn} { --muted: ${cssVal(c.muted)}; }\n` : "";
    return (root.length ? `:root { ${root.join("; ")}; }\n` : "") + (body.length ? `body { ${body.join("; ")}; }\n` : "") + blocks;
  }

  // ---------- ресурсы темы ----------
  const ASSET_URL = /url\(\s*(['"]?)asset:([\w.-]+)\1\s*\)/gi;
  // url(asset:имя) -> url("<адрес>"): make(ресурс) отдаёт адрес (обычно blob:) или "" — тогда none.
  // th — то, что вернул WMT.open (нужно th.assets: Map имя -> { bytes, mime }).
  const withAssets = (css, th, make) => String(css || "").replace(ASSET_URL, (m, q, name) => {
    const a = th?.assets?.get(name), u = a ? make(a, name) : "";
    return u ? `url("${u}")` : "none";
  });
  // Весь CSS темы для приложения app, привязанный к стилю id: общая секция ролей → секция приложения → tokens.
  // Ресурсы — blob: (их адреса возвращаются в urls: освободить через URL.revokeObjectURL, когда тема больше не нужна).
  // opts: core (имя общей секции), resolve (роли), mutedIn (см. tokensCss), extra (CSS приложения после tokens).
  function themeCss(th, id, app, opts = {}) {
    const urls = [];
    // значения из tokens идут после CSS темы — они главнее тех же переменных в CSS;
    // общая секция ролей — первой: правила под это приложение идут после и перекрывают её
    let css = (th.css(opts.core || CORE) || "") + "\n" + (th.css(app) || "") + "\n" + tokensCss(th.tokens, opts) + (opts.extra || "");
    css = withAssets(css, th, (a) => { const u = URL.createObjectURL(new Blob([a.bytes], { type: a.mime })); urls.push(u); return u; });
    return { css: scopeCss(css, id, new Set(urls), opts), urls };      // наружу CSS темы не ходит: разрешены только blob:-ресурсы этой же темы
  }

  // ---------- виджет для OBS: «@@ css whisper-obs» и «@@ settings whisper-obs» ----------
  // Виджет — отдельная страница в OBS, поэтому ресурсы темы вставляются прямо в CSS (data:), а всё, что ведёт
  // наружу (@import, url(http…), image-set…), вырезается: виджет ничего не загружает из сети, кроме обложки.
  function b64(bytes) {
    if (typeof Buffer !== "undefined" && typeof btoa === "undefined") return Buffer.from(bytes).toString("base64");
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function obsCss(th) {
    let css = withAssets(th.css(OBS) || "", th, (a) => (a.bytes.length > 1.5 * 1024 * 1024 ? "" : `data:${a.mime};base64,${b64(a.bytes)}`));
    css = css
      .replace(/@\s*import\b[^;]*;?/gi, "")
      .replace(/(?:-webkit-)?(image-set|cross-fade|element|paint|src)\s*\(/gi, "x-blocked(")
      .replace(/url\(\s*(?!["']?data:)[^)]*\)/gi, "none")
      .replace(/expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding/gi, "x-blocked:");
    const s = th.settings(OBS);
    return { css: css.length > 1024 * 1024 ? "" : css, settings: s && typeof s === "object" ? s : {} };
  }

  const CORE = "whisper-core", OBS = "whisper-obs";
  const api = {
    VERSION: "0.1.0", CORE, OBS,
    splitTop, cssParse, ruleText, splitDecls, unesc, cssSafe, scopeSel, scopeCss, extractFrom,
    cssVal, tokensCss, withAssets, themeCss, obsCss,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WhisperThemeCss = Object.freeze(api);
})(typeof window !== "undefined" ? window : globalThis);
