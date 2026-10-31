# Whisper Core

Общее ядро приложений Whisper на **Tauri 2**: Whisper Yandex (yandex-desktop), Whisper VK и следующих. Фронтенд —
**чистый JS/CSS без сборщика и фреймворков**, Rust-часть подключается в приложение через `#[path]`.
В каждом приложении ядро лежит **git-подмодулем в `src/core`**. Полное описание API — `docs/CORE.md`, формат тем —
`docs/WMT-FORMAT.md`. Этот файл — короткая памятка: что важно не сломать и как всё подключается.

## Главное правило

**В ядре нет ничего про конкретный сервис и конкретную разметку.** Ни Яндекса, ни VK, ни `#play`, ни `main.js`.
Всё про сервис — в провайдере приложения (`registerProvider`), всё про разметку — в ролях (`Whisper.ui.define`),
всё про оформление приложения — в наборе интерфейса (`Whisper.ui.provide`), всё про Rust приложения — в его
`src-tauri/src/whisper_host.rs`. Модулю чего-то не хватает — расширяется контракт (новое поле `caps`, метод
провайдера, функция набора, поле `media()`), а не код ядра под одно приложение. Любая правка здесь сразу действует
в ОБОИХ приложениях.

## Язык и стиль

- Интерфейс, комментарии, документация, сообщения коммитов — **по-русски**. Тексты в UI — на «ты», просто, без канцелярита.
- Комментарии объясняют **почему**, а не что. Код плотный: короткие функции, однострочники там, где читаемо.
- Модуль — IIFE `(() => { … })();`, свои помощники (`$w`, `$d`, `el`) внутри, наружу — только через `Whisper.*`
  (`Whisper.modules.<имя>`) и перечисленные ниже старые `window.*`.
- Модуль начинается с `const W = window.Whisper; if (!W) return;` — без ядра он молча не работает, а не падает.
- Rust: `#[tauri::command] pub fn/async fn имя(…) -> Result<…, String>`, тяжёлое — в `spawn_blocking`, у зависимости
  в `Cargo.toml` приложения — комментарий «зачем».

## Структура

```
whisper-core.js        ядро: шина событий, сущности, провайдер и caps, player, queue, sources, ui (роли, kit, trackMenu)
wmt.js                 формат темы .wmt (текст и zip), без зависимостей; браузер и Node
theme-css.js           движок CSS тем: привязка к стилю, фильтр безопасности cssSafe, роли, tokens, виджет OBS
base.css               базовое оформление общих классов (.panel, .modal, .nav, .switch…) для приложения без своих
queue.js/.css          панель «Очередь и история» (клавиша Q)
archive.js/.css        Whisper Archive: источник звука «archive», вход по почте, карточка, «Сохранить в архив»
together.js/.css       «Слушать вместе»: комнаты на сервере архива
discord.js/.css        Discord Rich Presence
obs.js/.css            виджет «Сейчас играет» для OBS
rust/whisper/          Rust архива и комнат: mod (ключ, альбомы), auth, upload, stream (wa://), rooms
rust/discord.rs        Rust Discord (IPC, переподключение, лимиты)
rust/obs.rs, rust/obs/ Rust виджета OBS (сервер на 127.0.0.1) и его страница widget.html / widget.js
rust/whisper_host.example.rs   образец того, что приложение даёт Rust ядра
rust/check/            сборка и тесты Rust ядра без приложения (своя заглушка whisper_host)
docs/CORE.md           ядро целиком: события, сущности, провайдер, плеер, роли (словарь), модули, подключение
docs/WMT-FORMAT.md     строгое описание формата .wmt
.github/workflows/check.yml    CI: node --check, движок тем в Node, cargo test в rust/check (Windows)
```

## Работа с подмодулем

- Правишь в `src/core` приложения (это обычный git-репозиторий) **или** в отдельной копии whisper-core.
- Порядок: коммит и `git push` **внутри** `src/core` → в приложении `git add src/core && git commit` (приложение
  запоминает версию ядра). Иначе у второго приложения и в CI будет старое ядро или «нет такого коммита».
- Взять свежее ядро в приложение: `git submodule update --remote src/core`, проверить, закоммитить.
- После `git pull` приложения: `git submodule update --init`. Клонировать: `git clone --recurse-submodules`.
- В CI приложения у `actions/checkout` — `with: { submodules: true }`.
- **`rust/check` запускай только в отдельной копии whisper-core, не в `src/core`**: Tauri встраивает в программу
  всю папку `src`, и `rust/check/target` (гигабайты) попал бы в установщик.
- Версия — `Whisper.version` (whisper-core.js) и `WhisperThemeCss.VERSION`. Меняется контракт — подними версию,
  опиши в docs/CORE.md и поставь тег (`git tag v0.2.0 && git push --tags`), чтобы было видно, с какой версии что поменялось.

## Подключение в приложение

### Фронтенд (index.html)
Порядок важен (все скрипты — `defer`, общая глобальная область):
1. `core/base.css` — **только** если у приложения нет своего оформления общих классов; ставится ПЕРЕД своим CSS.
2. Свой CSS приложения, затем CSS модулей ядра (`core/together.css` — сразу после общего оформления: перекрывает
   правила плеера и меню; `core/archive.css`, `core/queue.css`, `core/discord.css`, `core/obs.css`).
3. `core/whisper-core.js` — **первым** из скриптов.
4. Код приложения и его привязка к ядру (как `yandex.js` в Whisper Yandex): `Whisper.setApp`, `ui.define`,
   `registerProvider`, `player.bind`, `queue.bind`, `ui.provide`. Привязка — **до** движка тем: темы при запуске уже
   должны знать роли.
5. `core/wmt.js`, `core/theme-css.js` — перед движком тем приложения.
6. Модули: `core/archive.js`, `core/queue.js`, `core/discord.js`, `core/obs.js`, `core/together.js`
   (порядок, в котором модули ставят карточки настроек, = порядок подключения).

### Rust (src-tauri/src/lib.rs)
```rust
#[path = "../../src/core/rust/whisper/mod.rs"]
mod whisper;
#[path = "../../src/core/rust/discord.rs"]
mod discord;
#[path = "../../src/core/rust/obs.rs"]
mod obs;
mod whisper_host;   // своё: скопировать rust/whisper_host.example.rs и поправить
```
- Библиотеки в `Cargo.toml` приложения, без которых Rust ядра не соберётся: `tauri` 2, `tauri-plugin-http` 2,
  `serde` (derive), `serde_json`, `tokio` (`sync`, `time`), `getrandom` 0.3, а под `cfg(unix)` — `libc`.
  Ядру понадобилась новая библиотека — добавь её в `rust/check/Cargo.toml`, сюда и в docs/CORE.md: иначе у второго
  приложения сборка сломается.
- `whisper_host.rs` **обязан** дать: `token_get/token_set/token_clear` (ключ wa_… в системном хранилище),
  `heavy_slot()` (общий семафор больших файлов), `app_origin(origin)` (Origin своих окон для CORS `wa://`),
  `DEVICE_NAME`, `DISCORD_APP_ID`, `DISCORD_BUTTON`, `APP_URL`, `OBS_IMG_SRC` (CSP картинок виджета), `cover_ok(url)`.
  Ядро обращается к ним как `crate::whisper_host::…`. Новое требование к приложению — добавь его в образец,
  в заглушку `rust/check/src/lib.rs` и в docs/CORE.md.
- Каждая команда регистрируется в приложении в **трёх** местах: `generate_handler![…]` (полный путь:
  `whisper::wa_me`, `whisper::auth::wa_auth_issue`, `whisper::stream::wa_prefetch`, `whisper::rooms::wa_room_create`,
  `discord::discord_update`, `obs::obs_state`…), `build.rs` (`COMMANDS`), `capabilities/*.json` (`allow-имя`).
  Протокол: `register_asynchronous_uri_scheme_protocol("wa", …)` → `whisper::stream::serve_stream` (только главное окно).
- «Сохранить в архив» у каждого сервиса своё (`whisper_yandex.rs`): `whisper::upload::begin()` → скачать трек
  из сервиса → `TrackFile::new()` → `to_album()` или `album_title()` + `new_album()`. Бюджет и ключ — ДО скачивания.
- Новую команду ядра не переименовывай: имена — часть контракта с JS и с `capabilities` обоих приложений.

## Контракт ядра (кратко; подробно — docs/CORE.md)

- **`Whisper.setApp({ id, name, version, storage })`** — `id` = имя секции темы (`@@ css whisper-vk`), `storage` —
  приставка ключей `localStorage` модулей (Whisper Yandex — `ym_`, поэтому старые ключи `ym_history`, `ym_discord`,
  `ym_obs` сохранились). Сменить приставку = потерять сохранённое пользователем.
- **Провайдер** `registerProvider({ id, caps, toTrack, toArtist, toAlbum, toPlaylist, coverUrl, store, toRoom,
  fromRoom, accountLabel, archiveSave, search, …, stream })`. Все методы необязательны; модуль проверяет `caps`
  или наличие метода. Сущности — только через `Whisper.to(kind, raw)` / `Whisper.entity` (поля обрезаются и
  приводятся к типам); обложка — `Whisper.cover(x, px)` (шаблон `{size}` или `provider.coverUrl`).
- **Плеер приложения** `player.bind({ position, duration, context, play, pause, toggle, next, prev, seek, setVolume,
  setRate, playTrack, reload, media, like, dislike })` и отчёты `player.report({ track, playing, volume, liked,
  disliked, seek, rate, modes, queue, started, source, audible })`. Событие уходит, **только если значение
  изменилось**; `player:sync` (для `watch`) — на каждый отчёт о треке/пуске/перемотке/скорости/режимах.
- **`media()`** — что с самим файлом: `paused, ended, duration, pending, loading, startAt, has, time, rate,
  buffering, error`. По нему «Слушать вместе» синхронизируется, а Discord видит зависший звук. Поля, которых
  приложение не дало, берутся по умолчанию — модуль работает, но хуже.
- **Очередь** `queue.bind({ list, index, upcoming(max) → [{ index, track }], upcomingCount, label, playAt,
  playNext(track, { quiet }), add, remove(i) → убранный трек, move(from, to), play(tracks, start, context) })`.
  Порядок «что дальше» (перемешивание, волна, повтор) знает только приложение.
- **События** `on / once / off / emit`: `track, play, pause, playstate, volume, like, dislike, seek, rate, modes,
  queue, start, source, audible, room, provider, app, ui:roles`; `"*"` — все, кроме служебных `player:*`.
  `{ replay: true }` — сразу получить текущее состояние (подписка после старта ничего не пропускает).
- **Источники звука** `sources.register({ id, priority, resolve(track, next) → { id, url, blob? } | null })` —
  приложение спрашивает `sources.resolve` перед загрузкой трека и сообщает `report({ source })`.
- **Роли** `ui.define({ "search:global": "#search", … })` → `[data-w="role"]` в CSS тем. Часть — через «.»,
  разновидность — через «:»; роль включает все свои разновидности; роль, которой у приложения нет, — правило темы
  выбрасывается. Словарь — `VOCAB` в whisper-core.js и таблица в docs/CORE.md: **новая общая роль — в оба места**.
- **Набор интерфейса** `ui.provide({ toast, confirm, trackMenu, closeMenu, artists, image, decorateRow, icon, menu,
  settingsCard, secretSaved, accentColors, obsTheme, rangeFill })`. Для каждой функции в `KIT_DEF` есть простая
  замена или `null` (`trackMenu`, `settingsCard`; `menu` — только у приложения): тогда модуль обходится без неё
  (нет кнопки «⋯», нет карточки настроек). Модуль обязан работать без любой функции набора. Новая функция набора —
  запись в `KIT_DEF` обязательно.
- **Меню трека** `ui.trackMenu.add({ id, slot, build(track, m, ctx) })`; приложение зовёт `trackMenu.build(raw, ctx, slot)`
  в своём меню «⋯», `m` — из `kit.menu(raw, ctx)`.
- **`Whisper` заморожен** (`Object.freeze`): новое — новыми полями в исходнике ядра, модули кладут свой API
  в `Whisper.modules.<имя>`.

## Общие модули: что им нужно от приложения

| Модуль | Роли | Набор (kit) | Rust | Хранилище |
|---|---|---|---|---|
| queue | `player.volume`, `radio.stations` (куда встать кнопке), `main`, `player`, `menu`, `dialog`… (клик снаружи) | `toast, confirm, trackMenu, artists, image, decorateRow, icon` | — | `<storage>history` |
| archive | `player.cover` (печать «WA») | `settingsCard, menu, toast, closeMenu, secretSaved, icon("plus")` | `whisper/` + своя `archiveSave` | `wa_cfg`, ключ — в системном хранилище |
| together | `player.extra` / `player.actions`, `player.info`, `player.seek`… | `menu, toast, confirm` | `whisper/rooms.rs`, deeplink `whisper://room/…` | — |
| discord | — | `settingsCard` | `discord.rs` | `<storage>discord` |
| obs | — | `settingsCard, accentColors, obsTheme, rangeFill, toast` | `obs.rs` + `rust/obs/` | `<storage>obs` |

Модули сами ставят свои карточки настроек (`kit.settingsCard(card, { section, first, colbreak })`), сами строят
разметку окон и пользуются общими классами `.panel .login.modal .login-box .modalbox .field .nav .row .status
.switch .chip .lyrow .lyseg .slide .card .list` — у приложения они должны быть оформлены (своими стилями или `base.css`).
Окна модулей закрываются по Esc (перехват в фазе захвата, чтобы Esc не дошёл до приложения); клавиши модулей
(Q — очередь) не срабатывают в полях ввода `input, textarea, [contenteditable]`.

Старые имена для совместимости (вызываются из кода приложений и консоли — не удалять без проверки обоих приложений):
`window.qToggle`, `window.playNext` (даёт приложение), `window.waLogin`, `window.roomInfo`, `window.roomWantsPlay`,
`window.roomTake`, `window.roomCli`, `window.discordPush`, `window.obsPush`.

## Темы

- Порядок CSS темы: `@@ css whisper-core` (роли) → `@@ css <app>` → `tokens` → `colorOverrides` приложения.
  Всё собирает `WhisperThemeCss.themeCss(th, id, app, { mutedIn, resolve })`.
- Соглашения, на которые опирается привязка: стиль — `data-style` на `<html>`, анимации — `data-anim="on|off"`,
  основа — `data-base`; свои слои/анимации приложения не называть с `wmt-`.
- **Безопасность (`cssSafe`) не ослаблять**: тема — чужой файл. Проверка — после раскрытия `\`-экранирования
  и без комментариев; нельзя `@import`, `url()` куда-либо кроме ресурсов темы/`data:`/`#якорей`, `image-set/element/
  paint/src(`, `expression(`, `javascript:`; `@keyframes/@font-face/@layer` темы получают префикс `wmt-<id>-`.
  Любое изменение `theme-css.js` — сравнить вывод со старой версией на настоящих темах (одинаковый до символа).

## CSP и безопасность (у приложений Whisper одинаковые правила)

- **Нельзя**: `<style>`, атрибут `style="…"` в разметке, `setAttribute("style", …)`, `onclick="…"`, `eval`, внешние скрипты.
  **Можно**: `el.style.prop = …` / `setProperty` из JS; `innerHTML` с разметкой без стилей и обработчиков.
- Страница **сама в сеть не ходит**: все запросы — через Rust-команды (`window.__TAURI__.core.invoke`).
  Интерфейс не задаёт ни адрес, ни путь, ни метод — только данные; путь собирает Rust из проверенных id.
- Ключи и токены в JS не попадают; в Rust — только в системном хранилище (`whisper_host`).
- Картинки — только с адресов сервиса: в приложении — его `img-src`, в виджете OBS — `OBS_IMG_SRC` + `cover_ok`.

## Проверка

- `node --check *.js` — синтаксис. CI ядра (`check.yml`) ещё и прогоняет движок тем в Node и `cargo test` в `rust/check`.
- Тестов в браузере в репозитории нет — правку модуля проверяй **в обоих приложениях** (или на стенде: страница
  с ядром и заглушкой `window.__TAURI__`). Переносишь код из приложения в ядро — сравни поведение со старой версией:
  что модуль отправляет в Rust, разметку и вычисленные стили, сохранённые настройки.
- Rust: `cargo test --lib` в приложении (модули ядра компилируются в его составе) и в `rust/check` отдельной копии.

## Правила, о которые легко споткнуться

- `[hidden]` перебивается `display:` классов — в своих блоках добавляй `.блок [hidden] { display: none !important; }`.
- Учитывай 4 основы тем (`neon`, `royal`, `steam`, `lolitta`): у `royal`/`steam` квадратные углы, у `lolitta` свои
  переменные `--l-*`; `:root[data-anim="off"]` — без анимаций. Цвета — через `var(--accent)`, `var(--accent2)`,
  `var(--text)`, `var(--muted)`, а не числами.
- `base.css` — в `@layer whisper-base` и `:where()`: любое правило приложения главнее. Не повышай там специфичность
  и не выноси правила из слоя — иначе он начнёт перебивать оформление приложений.
- Отчёт `report` без изменения значения события не даёт; модулю, которому важен каждый отчёт, — `player.watch`.
- Трек, восстановленный с прошлого запуска, — тот же `id`: события `track` нет, бери состояние через `{ replay: true }`.
- «Слушать вместе»: сервер хранит поля трека, а не адрес в сервисе — в одной комнате клиенты одного сервиса.
- Виджет OBS берёт порт из 47821–47826: два приложения Whisper одновременно получат разные порты.
- Имена команд Rust, ключи хранилища и `window.*`-имена — часть контракта с приложениями: менять только вместе с ними.
