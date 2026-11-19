# Ядро Whisper и темы .wmt в своём приложении

Для независимых авторов: у тебя своё приложение (свой интерфейс, свой сервис, своё оформление), и ты хочешь,
чтобы в нём работали темы `.wmt` и, если нужно, общие модули Whisper. Приложения Whisper (Whisper Yandex, Whisper VK)
подключают ядро так же — просто глубже.

Что подходит к какому приложению:

| Твоё приложение | Что брать | Раздел |
|---|---|---|
| Любая веб-страница (Electron, Tauri, обёртка над сайтом, PWA) — только темы | `wmt.js` + `theme-css.js` + `embed.js` | 1 |
| То же, но темы, написанные для всех приложений Whisper (роли) | + `whisper-core.js` и `Whisper.ui.define` | 2 |
| Музыкальный плеер, хочешь очередь, архив, Discord, OBS | + привязка плеера и хост | 3 |
| Программа на Rust с нативным интерфейсом (iced, egui, Slint, GTK) | крейт `rust/wmt` (`whisper-wmt`) | 4 |
| Любая программа, которой нужна «одна тема во все приложения» | протокол Whisper API (`docs/API.md`) | 5 |

Лицензия ядра — GNU GPL 3.0 или новее (`GPL-3.0-or-later`, файл `LICENSE`). Можно всё: пользоваться, менять,
встраивать, продавать, — но программа с ядром внутри при распространении должна быть открытой под GPL-3.0
(или совместимой лицензией) и выходить вместе с исходным кодом. В закрытых программах ядро использовать нельзя.

Что это значит на практике:

* программа под GPL-3.0 (например, форк Telegram Desktop) — ядро вставляется как есть;
* программа под MIT, BSD, Apache-2.0 — ядро встроить можно, но вся программа целиком тогда распространяется
  по GPL-3.0 (свои файлы могут остаться под своей лицензией, она с GPL совместима);
* программа под GPL-2.0 «только эта версия» — несовместима с GPL-3.0;
* закрытая программа — нельзя;
* приложения Whisper (Whisper Yandex, Whisper VK, Whisper Mixer) и их некоммерческие форки — по отдельному
  разрешению (`LICENSE-EXCEPTION.md`) распространяются вместе с ядром по PolyForm Noncommercial 1.0.0; само ядро
  в них остаётся под GPL.

Сам формат `.wmt` и протокол Whisper API описаны открыто (`docs/WMT-FORMAT.md`, `docs/API.md`): их можно
реализовать самостоятельно, не беря код ядра, — тогда лицензия ядра не действует.

---

## Как подключить

**Без сборщика** — файлы как есть (так работают сами приложения Whisper):

```html
<script src="core/whisper-core.js"></script>   <!-- по желанию: роли и карта токенов -->
<script src="core/wmt.js"></script>
<script src="core/theme-css.js"></script>
<script src="core/embed.js"></script>
```

**Со сборщиком** (Vite, webpack, esbuild):

```bash
npm install github:Whisper-Music/whisper-core
```

```js
import { Whisper, WhisperEmbed, WMT, WhisperThemeCss } from "whisper-core";   // нужен браузер (window, document)
import { WMT, WhisperThemeCss } from "whisper-core/themes";                  // без DOM: Node, скрипты сборки
import "whisper-core/queue.js"; import "whisper-core/queue.css";              // общие модули — после своей привязки
```

Типы для TypeScript — `index.d.ts` (подхватываются сами).

**Git-подмодулем**, как в приложениях Whisper: `git submodule add https://github.com/Whisper-Music/whisper-core.git src/core`.

---

## 1. Только темы

```js
const bytes = new Uint8Array(await file.arrayBuffer());          // .wmt: текст или архив
const t = await WhisperEmbed.applyTheme(bytes, {
  app: "my-player",                                               // id твоего приложения = секция «@@ css my-player»
  map: {                                                          // куда ставить общие значения темы (tokens)
    "color.accent": ["--brand", ".header { border-color }"],
    "color.accent2": "--brand-2",
    "color.text": "--fg",
    "color.background": "body { background }",
    "effects.glow": "--glow",                                     // число с px
    "effects.panelOpacity": "--panel-opacity",
    "font.body": "body { font-family }",
  },
  background: "#app-bg",                                          // куда поставить картинку фона темы (необязательно)
});
// …
t.remove();                                                       // снять тему
```

Что делает `applyTheme`:

1. открывает файл (`WMT.open`) с теми же лимитами, что в приложениях Whisper (тема — чужой файл);
2. собирает CSS: `@@ css whisper-core` (если подключено ядро и роли) → `@@ css <app>` → `tokens` по твоей карте;
3. привязывает правила к теме (`:root[data-style="<id>"] …`) и пропускает их через фильтр безопасности: тема не ходит
   в сеть, не подменяет твои анимации, шрифты и слои; ресурсы темы — `blob:`;
4. подключает CSS через `adoptedStyleSheets` (строгий CSP без `'unsafe-inline'` не мешает), ставит на `<html>`
   `data-style="<id>"` и `data-anim="on"` (если ты сам его не ставишь).

**Карта tokens.** Цель — CSS-переменная (`--brand`, ставится на `:root` темы) или `«селектор { свойство }»`; можно
несколько целей массивом. Токенов вне карты тема не применит. Без карты — переменные Whisper
(`WhisperThemeCss.TOKEN_MAP`: `--accent`, `--accent2`, `--text`, `--muted`, `--glow`, `--panel-a`, `--bg-dim`,
`--bg-blur`, `--font-display`, фон и шрифт `body`). Можно взять их за основу: `{ ...WhisperThemeCss.TOKEN_MAP, "color.accent": "--brand" }`.

| Токен | Значение | Что получится |
|---|---|---|
| `color.accent`, `color.accent2` | строго `#rrggbb` | цвет |
| `color.text`, `color.muted`, `color.background` | значение CSS | как есть |
| `effects.glow` | 0–48 | `Npx` |
| `effects.panelOpacity` | 0.2–1 | число |
| `effects.dim` | 0–0.85 | число |
| `effects.backgroundBlur` | 0–48 | `Npx` |
| `font.body`, `font.display` | `font-family` | как есть |

Значения из чужого файла проверяются: без `; { } < > \`, `url(`, `expression`, не длиннее 300 символов; числа обрезаются.

**Своя секция темы.** Авторы тем могут писать правила специально под твоё приложение — секция `@@ css <твой id>`
(id в стиле `my-player`, лучше с ником: `nick-player`). Пиши в README своего приложения, какие у тебя классы.
Один файл темы обслуживает сразу несколько приложений: каждое читает только свою секцию.

**Проверить, подойдёт ли тема,** не применяя её:

```js
const info = await WhisperEmbed.inspect(bytes, { app: "my-player" });
info.hasApp      // есть ли секция под твоё приложение
info.hasCore     // есть ли общие правила по ролям
info.coverage    // { ratio: 0.8, missing: ["player.volume"] } — сколько ролей темы у тебя есть
```

Покажи это в своём списке тем («подходит на 80%»), чтобы человек не удивлялся, что тема выглядит не так, как на картинке.

---

## 2. Общие темы по ролям

Темы для всех приложений Whisper пишут правила не по классам, а по ролям: `[data-w="search"]`, `[data-w="player.play"]`.
Скажи ядру, какие твои элементы какую роль играют — и такие правила начнут действовать у тебя:

```js
Whisper.setApp({ id: "my-player", name: "My Player", version: "1.0" });
Whisper.ui.define({
  "header": ".top-bar",
  "search:global": "#search",
  "player": ".bottom-player",
  "player.play": ".bottom-player .play",
  "player.seek": ".bottom-player .progress",
  "track": ".tracks li:not(.active)", "track:playing": ".tracks li.active",
  "chat.message": ".msg", "chat.message:own": ".msg.out",
});
Whisper.ui.tokens({ "color.accent": "--brand" });   // карта по умолчанию для WhisperEmbed.applyTheme
```

В разметке ничего не меняется: ядро переписывает `[data-w="player"]` в `:is(.bottom-player)`. Роли, которой у тебя нет,
правило просто не находит. Весь словарь — `Whisper.ui.vocabulary()` и таблица в `docs/CORE.md` («Словарь ролей»):
кроме плеерных там есть общие — `header`, `profile`, `avatar`, `input`, `link`, `badge`, `list`, `list.item`,
`waveform`, `comment`, `chat`, `chat.message`, `chat.input`. Своих разновидностей и частей можно добавлять сколько угодно
(`search:global:people`, `player.extra.timer`); общую роль, которой не хватает всем, — предложи в whisper-core.

Обёртка над чужим сайтом: роли — это CSS-селекторы сайта. Сайты меняют разметку, поэтому держи соответствие
в одном месте и проверяй после обновлений сайта. Помни и о правилах самого сервиса: не каждый сервис разрешает
менять свой интерфейс.

---

## 3. Общие модули (плеер, очередь, архив, Discord, OBS)

Модули работают только через `Whisper.*`, поэтому к твоему плееру их подключает привязка — как `yandex.js` в Whisper Yandex.
Подробно — `docs/CORE.md`: «Провайдер и возможности», «Плеер и очередь», «Как подключить ядро в другом приложении».

```js
Whisper.registerProvider({ id: "my-service", caps: { like: true }, toTrack: (raw) => ({ id: raw.id, title: raw.name, artists: [{ name: raw.by }] }) });
Whisper.player.bind({ play, pause, toggle, next, prev, seek, setVolume, position: () => audio.currentTime, duration: () => audio.duration });
// в своём плеере — при смене трека, пуске/паузе, громкости…
Whisper.player.report({ track: raw, playing: !audio.paused, volume: audio.volume });
```

**Хост.** Модулям нужен бэкенд (Rust-команды Whisper Archive, Discord, OBS). В Tauri ядро берёт `window.__TAURI__`
само. На другой основе дай свои функции:

```js
Whisper.setHost({
  kind: "electron",
  invoke: (cmd, args) => window.myBridge.call(cmd, args),          // → Promise с ответом
  listen: (event, fn) => window.myBridge.on(event, (payload) => fn({ event, payload })),   // → Promise<отписка>
  fileUrl: (path, scheme) => `${scheme}://localhost/${path}`,     // адрес потока (архив: scheme "wa")
  openUrl: (url) => window.myBridge.open(url),                    // ссылка в браузере
  attention: () => window.myBridge.flash(),                       // мигнуть окном (приглашение в комнату)
});
```

Чего хост не дал, модуль не делает: `invoke` без хоста — понятная ошибка, `listen` — пустая отписка.
Список команд, которые зовут модули, и что они получают — в Rust-части ядра (`rust/`) и в `docs/CORE.md`.
Rust-часть ядра (`rust/whisper/`, `rust/discord.rs`, `rust/obs.rs`) сейчас подключается только в приложения на Tauri 2.

Модулям нужны и общие классы оформления (`.panel`, `.modal`, `.switch`, `.chip`…): если своих нет, подключи
`core/base.css` первой таблицей стилей — она в `@layer` и `:where()`, любое твоё правило главнее.

---

## 4. Rust с нативным интерфейсом — крейт `whisper-wmt`

CSS нативному интерфейсу не нужен, а цвета, шрифты, эффекты и фон темы — да. Крейт читает `.wmt` (текст и архив)
по тем же правилам и с теми же лимитами, что `wmt.js`, и **без зависимостей** (свой inflate и JSONC).

```toml
[dependencies]
whisper-wmt = { git = "https://github.com/Whisper-Music/whisper-core" }
```

```rust
let th = whisper_wmt::open(&std::fs::read(path)?)?;
let t = th.tokens();                                  // уже проверенные значения
let accent = t.accent.as_deref().and_then(whisper_wmt::rgba);   // Some([r, g, b, 255])
let text = t.text.as_deref().and_then(whisper_wmt::rgba);       // #rgb, #rrggbbaa, rgb()/rgba(); прочее — None
let glow_px = t.glow.unwrap_or(0.0);
if let Some(bg) = th.background() { /* bg.name, bg.mime, bg.bytes — картинка или видео */ }
let mine = th.settings("my-app");                     // свои настройки темы: @@ settings my-app (JSON → whisper_wmt::Value)
let font = th.asset("asset:font.woff2");              // ресурсы темы по имени
```

`th.css(app)` и `th.roles_used(Some(app))` пригодятся, если интерфейс всё-таки на webview.
Проверка: `cargo test` в `rust/wmt` (в отдельной копии whisper-core, не в `src/core` приложения).

---

## 5. Одна тема во все приложения — Whisper API

Приложения Whisper на одном компьютере управляют друг другом через локальный HTTP на 127.0.0.1 (реестр запущенных
приложений + действия). Так микшер ставит одну тему сразу во все клиенты. Протокол — `docs/API.md`; реализовать его можно
на любом языке. В веб-приложении на Tauri достаточно `core/api.js` + `rust/api.rs`: обработчик «POST theme» получит
байты `.wmt` — примени их через `WhisperEmbed.applyTheme` (или `whisper_wmt::open` в Rust).

---

## Что не переносится

* Секция `@@ css whisper-music` — правила под разметку Whisper Yandex. В твоём приложении от темы, написанной только
  под неё, останутся цвета и шрифты (`tokens`) и общие правила по ролям. Самые узнаваемые темы перестраивают интерфейс
  целиком — это возможно только в своей секции.
* `@@ settings whisper-music` (кнопки темы, консоль, частицы) — возможности самого Whisper Yandex. Свои возможности
  тем — в `@@ settings <твой id>`.
* Основы `neon / royal / steam / lolitta` (`manifest.base`) — встроенные стили Whisper Yandex; в другом приложении это
  просто подсказка, на какой вид рассчитана тема.
