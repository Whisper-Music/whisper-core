// Скрипт виджета OBS (отдаётся obs.rs по /widget.js). Отдельным файлом, а не внутри HTML:
// у страницы строгая CSP (script-src 'self'), встроенные скрипты и любые чужие адреса запрещены.
(() => {
  const w = document.getElementById("w"), q = (s) => w.querySelector(s);
  const LAYOUTS = ["card", "compact", "bar"], BASES = ["neon", "royal", "steam", "lolitta"];
  let s = null, themeVer = -1, lastId = null, fails = 0;
  // ключ доступа из адреса виджета (http://127.0.0.1:<порт>/?k=…): без него приложение данные не отдаёт
  const KEY = encodeURIComponent(new URLSearchParams(location.search).get("k") || "");
  const color = (c, d) => (/^#[0-9a-f]{6}$/i.test(c || "") ? c : d);
  const fmt = (t) => { t = Math.max(0, Math.floor(t)); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };
  // только https и без символов, которыми можно выйти из url("…") в CSS (кавычки, скобки, \, пробелы).
  // Чьи обложки можно показывать, решает приложение: чужие адреса obs.rs убирает ещё до страницы (whisper_host::cover_ok),
  // а CSP страницы пускает картинки только с адресов сервиса (whisper_host::OBS_IMG_SRC).
  const safeImg = (u) => (/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9\-._~\/%?=&:+,;@]*$/i.test(u || "") && u.length <= 2048 ? u : "");

  function apply(st, set) {
    s = st;
    const has = !!(st && st.has);
    w.toggleAttribute("data-empty", !has);
    if (!has) return;
    // настройки: что выбрал пользователь, иначе — что задал стиль (settings whisper-obs), иначе — по умолчанию.
    // set.layouts — какие виды стиль умеет: выбор пользователя вне этого списка заменяется видом стиля
    const ok = Array.isArray(set && set.layouts) ? set.layouts.filter((l) => LAYOUTS.includes(l)) : [];
    const allowed = ok.length ? ok : LAYOUTS;
    const layout = allowed.includes(st.layout) ? st.layout : allowed.includes(set && set.layout) ? set.layout : allowed.includes("card") ? "card" : allowed[0];
    w.dataset.layout = layout;
    w.dataset.base = BASES.includes(st.base) ? st.base : "neon";
    const alpha = typeof st.alpha === "number" ? st.alpha : typeof (set && set.opacity) === "number" ? set.opacity : 0.55;
    w.style.setProperty("--alpha", Math.min(1, Math.max(0, alpha)));
    w.style.setProperty("--a", color(st.accent, "#a66bff"));
    w.style.setProperty("--b", color(st.accent2, "#e060ff"));
    w.toggleAttribute("data-playing", !!st.playing);
    w.toggleAttribute("data-paused-hidden", !st.playing && !!st.hideOnPause);
    const id = st.id + "|" + st.title;
    if (id !== lastId) {
      const first = lastId === null;
      lastId = id;
      const img = q(".w-cover"), url = safeImg(st.cover);
      const fill = () => {
        q(".w-title").textContent = st.title || "";
        q(".w-artist").textContent = st.artist || "";
        w.style.setProperty("--cover", url ? `url("${url}")` : "none");
        if (url) img.src = url; else img.removeAttribute("src");
      };
      if (first) fill();
      else {
        w.classList.add("swapping"); img.classList.add("swap");
        setTimeout(() => { fill(); w.classList.remove("swapping"); }, 300);
        img.onload = () => img.classList.remove("swap");
        img.onerror = () => img.classList.remove("swap");
      }
    }
    q(".w-dur").textContent = fmt(st.dur || 0);
  }

  // прогресс идёт сам между опросами — с учётом скорости воспроизведения
  function tick() {
    if (s && s.has && s.dur > 0) {
      const pos = Math.min(s.dur, s.pos + (s.playing ? ((Date.now() - s.at) / 1000) * (s.rate || 1) : 0));
      w.style.setProperty("--p", (pos / s.dur).toFixed(4));
      q(".w-cur").textContent = fmt(pos);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  async function poll() {
    try {
      const r = await fetch("/state?k=" + KEY, { cache: "no-store" });
      const d = await r.json();
      fails = 0;
      if (d.themeVer !== themeVer) {
        themeVer = d.themeVer;
        document.getElementById("themeCss").href = "/theme.css?k=" + KEY + "&v=" + themeVer;
      }
      apply(d.state, d.settings);
    } catch {
      // приложение закрыто или виджет выключен — тихо прячемся и ждём
      if (++fails >= 3) w.setAttribute("data-empty", "");
    }
    setTimeout(poll, 1000);
  }
  poll();
})();
