# Whisper Core

Общее ядро приложений Whisper на Tauri: **Whisper Yandex** ([yandex-desktop](https://github.com/Whisper-Music/yandex-desktop)),
**Whisper VK** и следующих. Одна шина событий, одни сущности (трек, артист, альбом, плейлист), одни темы `.wmt`
и общие модули — очередь, Whisper Archive, «Слушать вместе». Приложение отвечает только за свой сервис и свою разметку.

Без сборщика и зависимостей: обычные скрипты и стили, как во всём фронтенде Whisper.

## Что внутри

| Файл | Что это |
|---|---|
| `whisper-core.js` | ядро: события, сущности, провайдер и его возможности (`caps`), `Whisper.player`, `Whisper.queue`, источники звука, роли интерфейса для тем |
| `wmt.js` | формат темы `.wmt`: разбор и сборка (текст и zip-архив), браузер и Node |
| `theme-css.js` | движок CSS тем: привязка к стилю, фильтр безопасности, роли → селекторы, `tokens`, виджет OBS |
| `queue.js` + `queue.css` | панель «Очередь и история» (клавиша Q) |
| `archive.js` + `archive.css` | Whisper Archive: свои треки вместо версий сервиса, вход по почте, «Сохранить в архив» |
| `together.js` + `together.css` | «Слушать вместе»: комнаты на сервере Whisper Archive |
| `rust/whisper/` | Rust-часть Whisper Archive и комнат: ключ, вход, загрузка, протокол `wa://`, комнаты |
| `rust/whisper_host.example.rs` | образец того, что приложение даёт Rust-части (хранилище ключа, семафор, Origin, подпись) |
| `rust/check/` | сборка и тесты `rust/whisper/` без приложения |
| `docs/CORE.md` | полное описание ядра: события, провайдер, плеер, роли, общие модули, подключение |
| `docs/WMT-FORMAT.md` | строгое описание формата `.wmt` |

## Подключение в приложение

Ядро живёт в приложении git-подмодулем **в `src/core`** (там, где Tauri берёт фронтенд: `frontendDist: "../src"`).

```bash
git submodule add https://github.com/Whisper-Music/whisper-core.git src/core
git commit -m "Ядро Whisper подмодулем"
```

Склонировать приложение вместе с ядром: `git clone --recurse-submodules …`; в уже склонированном —
`git submodule update --init`. В CI у `actions/checkout` нужно `with: { submodules: true }`.

**Фронтенд** (`index.html`): `core/whisper-core.js` — первым, потом код приложения и его привязка к ядру
(`Whisper.setApp`, `ui.define`, `registerProvider`, `player.bind`, `queue.bind` — как `yandex.js` в Whisper Yandex),
потом `core/wmt.js`, `core/theme-css.js` и общие модули. Подробно — `docs/CORE.md`, «Как подключить ядро в другом приложении».

**Rust** (`src-tauri/src/lib.rs`):

```rust
#[path = "../../src/core/rust/whisper/mod.rs"]
mod whisper;
mod whisper_host; // своё у приложения: скопировать rust/whisper_host.example.rs в src-tauri/src/whisper_host.rs
```

Команды регистрируются как обычно (`generate_handler!`, `build.rs`, `capabilities`): `whisper::wa_token_exists`,
`whisper::auth::wa_auth_issue`, `whisper::stream::wa_prefetch`, `whisper::rooms::wa_room_create` и т. д.; протокол `wa` →
`whisper::stream::serve_stream`. «Сохранить в архив» у каждого сервиса своё (скачать трек из сервиса →
`whisper::upload`), пример — `docs/CORE.md`.

## Работа с ядром

* Правишь ядро **в его репозитории** (или прямо в `src/core` приложения — это обычный git-репозиторий): коммит и push
  в whisper-core, потом в приложении `git add src/core && git commit` — приложение запоминает новую версию ядра.
* Обновить ядро в другом приложении: `git submodule update --remote src/core`, проверить, закоммитить.
* Ядро не знает ни о Яндексе, ни о VK: всё про сервис — в провайдере и привязке приложения, всё про разметку — в ролях
  (`Whisper.ui.define`). Если модулю ядра чего-то не хватает — расширяется провайдер или набор интерфейса
  (`Whisper.ui.provide`), а не код ядра под одно приложение.
* Проверка без приложения: `node --check *.js`; `cargo test --lib` в `rust/check` (Windows или Linux с библиотеками Tauri).
  То же делает CI (`.github/workflows/check.yml`).
  **Запускай `rust/check` только в отдельной копии whisper-core, не в `src/core` приложения:** Tauri встраивает в
  программу всю папку `src`, и папка сборки `rust/check/target` (гигабайты) попала бы в установщик.

Версия ядра — `Whisper.version` (`whisper-core.js`) и `WhisperThemeCss.VERSION` (`theme-css.js`).

## Лицензия

[PolyForm Noncommercial 1.0.0](LICENSE), как у приложений Whisper.
