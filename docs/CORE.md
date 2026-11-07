# Whisper Core — общее ядро приложений Whisper

Ядро — репозиторий **whisper-core**: в каждом приложении Whisper на Tauri (Whisper Yandex, Whisper VK, …) он лежит
git-подмодулем в `src/core`, поэтому пути ниже — `src/core/…`. Главный файл — `src/core/whisper-core.js`, без
зависимостей и без сборки. Как подключить — `README.md` репозитория и раздел «Как подключить ядро в другом приложении». Ядро не знает ни о Яндексе, ни о разметке
конкретного приложения. Приложение подключает его **первым**, а потом сообщает ядру три вещи:

1. **кто оно** — `Whisper.setApp({ id, name })`;
2. **с каким сервисом работает** — регистрирует провайдера (`Whisper.registerProvider`);
3. **как у него устроены плеер, очередь и разметка** — `Whisper.player.bind`, `Whisper.queue.bind`, `Whisper.ui.define`.

После этого модули (очередь, Discord, OBS, статистика, темы…) работают через `window.Whisper` и не зависят
от глобальных переменных приложения. Значит, их можно переносить между приложениями.

```
            ┌──────────── приложение (Whisper Yandex / Whisper VK) ────────────┐
            │  main.js — страницы, плеер, очередь           yandex.js — привязка│
            │        │ report(...)                    bind / define / provider  │
            └────────┼─────────────────────────────────────────┼───────────────┘
                     ▼                                         ▼
            ┌──────────────────────────── Whisper Core ───────────────────────────┐
            │ шина событий · сущности · провайдер и возможности · player · queue · ui │
            └──────────────┬───────────────────────────────┬──────────────────────┘
                           ▼                               ▼
                 модули (on("track"), player.next())   темы (@@ css whisper-core по ролям)
```

В Whisper Yandex (пример подключения):

| Файл | Что делает |
|---|---|
| `src/core/whisper-core.js` | ядро (общее) |
| `src/yandex.js` | Яндекс в ядре: роли разметки, провайдер `yandex`, привязка плеера и очереди `main.js` |
| `src/main.js` | сообщает ядру о событиях плеера через `wReport({...})` |
| `src/core/wmt.js` | **общий**: формат файла темы `.wmt` — разбор и сборка (текст и архив) |
| `src/core/theme-css.js` | **общий**: движок CSS тем — привязка к стилю, фильтр безопасности, роли, tokens, виджет OBS |
| `src/theme.js` | темы в этом приложении: загрузка, хранение, фон, карточки стилей, «Сохранить стиль в файл» |
| `src/core/queue.js` + `queue.css` | **общий модуль**: панель «Очередь и история» (раздел «Общие модули») |
| `src/core/archive.js` + `archive.css` | **общий модуль**: Whisper Archive — свои треки вместо версий сервиса, вход, «Сохранить в архив» |
| `src/core/together.js` + `together.css` | **общий модуль**: «Слушать вместе» — комнаты через сервер Whisper Archive |
| `src/core/discord.js` + `discord.css` | **общий модуль**: Discord Rich Presence |
| `src/core/obs.js` + `obs.css` | **общий модуль**: виджет «Сейчас играет» для OBS |

Порядок в `index.html`: `core/whisper-core.js` → `main.js` → `yandex.js` → остальные модули (в том числе `core/archive.js`,
`core/queue.js`, `core/together.js`; `core/wmt.js` и `core/theme-css.js` — перед `theme.js`).

---

## Шина событий

```js
const off = Whisper.on("track", ({ track, prev }) => { … });   // подписка, возвращает «отписаться»
Whisper.once("play", fn);
Whisper.on("*", (event, payload) => console.log(event, payload));   // все события — для отладки
Whisper.on("track", fn, { replay: true });     // сразу получить текущее (трек, playstate, volume, rate, modes)
Whisper.player.watch((force) => send());        // «посмотри ещё раз, что играет» — для мини-плеера, OBS, Discord
```

`replay` нужен модулю, который подключился позже: он сразу получает текущий трек, а не ждёт следующего.

Ошибка в одном слушателе не ломает плеер и остальных слушателей: ядро пишет её в консоль и идёт дальше.

| Событие | Когда | Данные |
|---|---|---|
| `track` | сменился трек | `{ track, prev, position, liked, disliked }` |
| `play` / `pause` | музыка пошла / встала | `{ track }` |
| `playstate` | любое из двух выше | `{ playing, track }` |
| `volume` | изменилась громкость | `{ volume }` (0…1) |
| `like` | лайк текущего трека поставили или сняли | `{ track, liked }` |
| `dislike` | то же для «Не нравится» | `{ track, disliked }` |
| `seek` | перемотка | `{ position, track }` (секунды) |
| `rate` | изменилась скорость воспроизведения | `{ rate }` (1 — обычная) |
| `modes` | повтор / перемешивание (или можно ли их менять здесь) | `{ available, shuffle, repeat }` (repeat: 0 — нет, 1 — список, 2 — трек) |
| `queue` | очередь изменилась (новый трек, «играть следующим», дозагрузка волны) | `{}` |
| `start` | трек включили (повтор после сбоя загрузки — не считается) | `{ track }` |
| `audible` | звук реально пошёл (после загрузки и буферизации; у Whisper Yandex — событие `playing` у audio) | `{ track }` |
| `room` | «Слушать вместе»: комната изменилась (вошёл, вышел, сменился ведущий, отошёл гость) | `{ inRoom, code, host, follow, roleChanged? }` |
| `source` | откуда звук у текущего трека: id источника (`"archive"`), `"local"` — скачанный файл, `"provider"` — сам сервис | `{ source, track }` (на каждый трек, без сравнения) |
| `provider` | зарегистрирован или выбран провайдер | `{ provider }` |
| `app`, `ui:roles`, `player:bound` | служебные | — |

События уходят **только при настоящем изменении**: повторная установка той же громкости или тот же трек события
не дают. Лайк нового трека при его смене приходит в событии `track`, а не отдельным `like`. Поэтому `play`
на треке, восстановленном с прошлого запуска, даёт `play` и `queue`, но не `track`: трек не сменился.

### `Whisper.player.watch(fn)` — для модулей, которые отправляют «что играет» наружу

`fn(force)` вызывается на **каждом** отчёте приложения о треке, пуске/паузе, перемотке, скорости или режимах, даже
если значение не поменялось. Так раньше работал крючок `window.miniPush`. Это нужно модулям, у которых своё понимание
состояния: Discord, например, сам проверяет, не завис ли плеер на загрузке. Такой модуль собирает снимок
(`Whisper.player.state()`), сравнивает с тем, что уже отправил, и шлёт только новое. `force = true` — после
перемотки или смены скорости: время нужно отправить заново, даже если всё остальное прежнее.

Сейчас на `watch` работают `traymini.js` (мини-плеер у значка в трее), `obs.js` (виджет для OBS), `discord.js`
и `together.js` («Слушать вместе»). Служебное событие под ним (`player:sync`) в `Whisper.on("*")` не попадает.

---

## Сущности

Одинаковая форма данных во всех приложениях. В `raw` лежит исходный объект сервиса: модуль, которому нужно
что-то особенное, берёт это оттуда, но общие системы пользуются только полями.

```js
Track    { kind: "track", provider, id, title, version, artists: [{ id, name }], album: { id, title } | null,
           cover, durationMs, explicit, available, raw }
Artist   { kind: "artist", provider, id, name, cover, description, raw }
Album    { kind: "album", provider, id, title, artists, cover, year, trackCount, tracks: Track[] | null, raw }
Playlist { kind: "playlist", provider, id, title, owner: { id, name } | null, cover, trackCount, editable, tracks, raw }
User     { kind: "user", provider, id, name, avatar, raw }
```

* `id` — всегда строка.
* `cover` — шаблон адреса: `{size}` заменяется на размер, `Whisper.cover(track, 200)` →
  `https://…/200x200`. Если у сервиса фиксированные размеры (как у VK), кладите готовый адрес без `{size}`.
* `Whisper.to("track", raw)` превращает данные сервиса в сущность через `toTrack` текущего провайдера.
  Уже готовую сущность функция возвращает как есть.

---

## Провайдер и возможности

Провайдер — это мост к музыкальному сервису. Он отдаёт данные и поток для трека. Очередь, повтор,
перемешивание, громкость, история, темы, Discord и OBS — забота приложения и ядра, а не провайдера.

```js
Whisper.registerProvider({
  id: "vk", name: "VK Музыка",
  caps: { like: false, library: true, radio: true, radioSeeds: ["user"], search: ["track", "artist", "album", "playlist"],
          social: ["friends-listening"], lyrics: "plain" },
  toTrack: (raw) => ({ id: raw.owner_id + "_" + raw.id, title: raw.title, artists: [{ id: "", name: raw.artist }],
                       cover: raw.album?.thumb?.photo_300 || "", durationMs: raw.duration * 1000, raw }),
  async search(text, type, page) { … return { tracks, artists, albums, playlists, best }; },
  async stream(track) { return { kind: "hls", url: "…m3u8" }; },
  …
});
Whisper.caps("library");            // true
Whisper.caps("playlists.edit");     // false — не объявлено, значит «не умеет»
Whisper.caps("search").includes("album");
```

### Возможности (`caps`)

Чего провайдер не объявил, того он не умеет (`false` / пустой список). Интерфейс и модули прячут то, что
сервис не поддерживает, вместо того чтобы делать все сервисы одинаковыми.

| Ключ | Значения | Пример |
|---|---|---|
| `playback` | `"local"` — звук играет приложение (нужен `stream`), `"remote"` — пульт чужого плеера | Spotify — `"remote"` |
| `queue` | своя очередь: «играть следующим», перестановка | по умолчанию `true` |
| `like`, `dislike` | лайк, «Не нравится» | Яндекс — оба |
| `library` | своя коллекция: добавить трек к себе / убрать | VK «Моя музыка» |
| `playlists` | `{ read, create, edit, reorder, delete }` | |
| `radio`, `radioSeeds` | бесконечный поток и от чего его запускать: `user track artist album genre mood …` | «Моя волна», «VK Микс» |
| `lyrics` | `false` \| `"plain"` \| `"synced"` | |
| `search` | что ищется: `track artist album playlist user` | |
| `download` | скачивание на диск | |
| `quality` | выбираемое качество: `low high lossless` | |
| `social` | `listen-together`, `friends-listening` («Слушайте друг друга»), … | |

### Методы провайдера

Все методы необязательны и асинхронны, возвращают сущности ядра. Модуль проверяет `caps` (или само наличие
метода) перед вызовом.

| Метод | Возвращает |
|---|---|
| `toTrack(raw)`, `toArtist`, `toAlbum`, `toPlaylist` | поля сущности (синхронно) |
| `store(raw)` | что сохранять о треке на диск (история) — короткое описание без лишнего |
| `toRoom(track)`, `fromRoom(obj)`, `accountLabel` | «Слушать вместе»: трек в формате сервера комнат и обратно; «аккаунта Яндекса» для текстов |
| `coverUrl(entity, px)` | адрес обложки (синхронно), если у сервиса свои правила: Яндекс без сети отдаёт пусто, адреса — только со своих доменов. Нет метода — `Whisper.cover` подставляет размер в `{size}` |
| `search(text, type, page)` | `{ tracks, artists, albums, playlists, best: { type, item } \| null }` |
| `tracks(ids)` | `Track[]` |
| `album(id)` | `Album` с `tracks` |
| `artist(id)` | `Artist` (+ `similar: Artist[]`) |
| `artistTracks(id, page)`, `artistAlbums(id, page)` | `{ tracks \| albums, total }` |
| `likes()` | id лайкнутых треков (новые сверху) |
| `like(track, on)`, `dislike(track, on)` | — |
| `library()`, `libraryAdd(track)`, `libraryRemove(track)` | своя коллекция (VK) |
| `playlists()`, `playlist(id)` | `Playlist[]`, `Playlist` с `tracks` |
| `radio.start(seed)`, `radio.more(session, lastTrack)` | `{ session, tracks }`, `{ tracks }` |
| `lyrics(track)` | `{ type: "synced", lines: [{ t, text }] }` \| `{ type: "plain", text }` \| `{ type: "none" }` |
| `stream(track)` | `{ kind: "url" \| "hls" \| "file", url, mime? }` |

`kind: "hls"` нужен, например, VK: аудио там отдаётся плейлистом m3u8 с частями, а не одним файлом. Как играть
HLS, решает приложение. Ядру достаточно знать вид потока.

---

## Плеер и очередь

Модули управляют плеером и очередью только так. Что за этим стоит в конкретном приложении, им знать не нужно.

```js
Whisper.player.state();    // { track, playing, volume, liked, disliked, rate, modes, position, duration, context }
Whisper.player.play(); .pause(); .toggle(); .next(); .prev(); .seek(42); .setVolume(0.5); .setRate(1.25); .like(); .dislike();
Whisper.player.playTrack(track, { at: 12, hold: true, context: "room" });   // включить этот трек вместо очереди; hold — загрузить без звука
Whisper.player.reload(12, true);   // загрузить текущий трек, который ещё не загружался (восстановлен с прошлого запуска)
Whisper.player.media();    // { paused, ended, duration (0 — неизвестна), pending, loading, startAt,
                           //   has, time, rate, buffering, error } — что с самим файлом: синхронизация, «не завис ли звук»

Whisper.queue.list();      // Track[]
Whisper.queue.index();     // номер играющего, -1 — ничего
Whisper.queue.upcoming(5); // следующие треки в том порядке, в каком заиграют: [{ index, track }]
Whisper.queue.upcomingCount(); Whisper.queue.label();   // сколько их всего; откуда очередь («из лайков», «Моя волна»)
Whisper.queue.playAt(3); .playNext(track, { quiet }); .add(track); .play([t1, t2], 0);
Whisper.queue.remove(index);   // → убранный трек (чтобы вернуть через playNext)
Whisper.queue.move(0, 2);      // перестановка внутри upcoming(): позиции в нём, 0 — ближайший
```

`context` — откуда играет музыка: `{ type: "radio" | "album" | "likes" | "playlist" | "other", id, title }`.

### Как приложение подключает свой плеер

```js
// один раз: что вызывать
Whisper.player.bind({ toggle, play, pause, next, prev, seek, setVolume, like, dislike,
                      position: () => audio.currentTime, duration: () => audio.duration, context: () => ({ … }) });
Whisper.queue.bind({ list: () => queue, index: () => current, upcoming, upcomingCount, label,
                     playAt, playNext, add, remove, move, play });

// каждый раз, когда что-то случилось
Whisper.player.report({ track: raw, position: 0, liked: true });   // сменился трек
Whisper.player.report({ playing: true });
Whisper.player.report({ volume: 0.7 });
Whisper.player.report({ seek: 42 });
Whisper.player.report({ rate: 1.25 });
Whisper.player.report({ modes: { available: true, shuffle: false, repeat: 1 } });
Whisper.player.report({ queue: true });
Whisper.player.report({ started: raw });        // трек включили — для истории (событие «start»)
Whisper.player.report({ source: "archive" });   // откуда звук (событие «source»): id источника | "local" | "provider"
Whisper.player.report({ audible: true });       // звук реально пошёл (событие «audible»)
```

Что «дальше» и как переставлять, решает приложение, потому что у него свой порядок перемешивания, волна и повтор.
В Whisper Yandex эти операции лежат в `yandex.js`, в разделе «очередь».

В Whisper Yandex привязка лежит в `yandex.js`, а `report` вызывает `main.js` (через `wReport`) в `showTrack` (в конце,
когда обложка, цвета и режимы уже новые), `syncIcons`, `setVol`, `setSpeed`, `updateModes`, `refreshHearts`, на перемотке
и при дозагрузке волны; `queue.js` — после правки очереди. Кнопки «вперёд» и «назад» ядро нажимает так
же, как пользователь, поэтому вся логика `main.js` сохраняется: волна, повтор, перемешивание, «Слушать вместе»,
сторож воспроизведения.

---

## Источники звука

Свои места, откуда можно сыграть трек вместо сервиса. Сейчас такой источник один: Whisper Archive. Перед загрузкой
трека приложение спрашивает ядро:

```js
const hit = await Whisper.sources.resolve(track, nextTrack);   // { source: "archive", id, url, blob? } | null
if (hit) { audio.src = hit.url; Whisper.player.report({ source: hit.source }); }
else     { audio.src = (await provider.stream(track)).url; Whisper.player.report({ source: "provider" }); }
// поток не заиграл — запасной путь: файл целиком (hit.blob()), а если и его нет — версия сервиса
```

Источник регистрируется так:

```js
Whisper.sources.register({ id: "archive", name: "Whisper Archive", priority: 10,
  async resolve(track, next) { … return { id, url, blob: () => fetchWhole(id) } | null; } });
```

`resolve` не бросает ошибок и не держит долго (архив ждёт свой список треков при первом запуске не дольше 6 с).
Источники опрашиваются по `priority`, от большего к меньшему. Скачанные на диск треки — забота самого приложения:
в Whisper Yandex они проверяются раньше всех источников и сообщаются как `source: "local"`.

## Меню трека для общих модулей

Модуль может добавить свой пункт в меню «⋯» трека (как «Сохранить в архив»), не зная, как это меню устроено:

```js
Whisper.ui.trackMenu.add({ id: "archive", build(track, m, ctx) {
  m.item(icon, "Сохранить в архив", () => openSub(track, m), { keep: true, arrow: true });
} });
```

Приложение в своём меню вызывает `Whisper.ui.trackMenu.build(rawTrack, ctx, slot)` там, где должны стоять такие пункты:
`slot` `"top"` — самый верх меню (блок «Слушать вместе»), `"main"` (по умолчанию) — рядом с плейлистами. `build`
пункта возвращает `false`, если ничего не добавил, а `trackMenu.build` — сколько пунктов добавлено, чтобы поставить
разделитель. Ещё приложение отдаёт в наборе интерфейса `menu(rawTrack, ctx)` — объект с методами:

| Метод | Что делает |
|---|---|
| `item(icon, text, fn, { keep, arrow, danger, to })` | пункт (→ элемент); `keep` — не закрывать меню, `arrow` — «›», `to` — в какой контейнер |
| `note(text, to)` | подпись (→ элемент) |
| `head(text)` | заголовок вложенного меню с «←» обратно в главное |
| `scroll()` | прокручиваемый контейнер для длинного списка (→ элемент) |
| `reset()` → `seq`, `alive(seq)` | очистить меню; проверить, что оно ещё то же (после `await`) |
| `place()` | пересчитать положение после изменения |
| `anchor()`, `reopen(anchor, build)`, `close()` | кнопка, у которой открыто меню; открыть заново; закрыть |
| `append(el)` | свой блок целиком (например, «Слушать вместе · КОД» с пунктами внутри) |

---

## Роли интерфейса — общие темы

Тема пишет CSS не по классам конкретного приложения, а **по ролям**:

```
@@ css whisper-core
[data-w="search"] { border-radius: 0; border: 1px solid var(--accent); }
[data-w="player.volume.slider"] { accent-color: var(--accent2); }
[data-w="track:playing"] [data-w="track.title"] { color: var(--accent); }
```

Каждое приложение объявляет, какие его элементы какую роль играют:

```js
Whisper.ui.define({
  "search:global": "#search",
  "search:library": "#lkFindIn",
  "player.volume": "#volWrap",
  …
});
```

а ядро (`Whisper.ui.resolve`) при загрузке темы переписывает роль в селекторы приложения:
`[data-w="search"]` → `:is(#search, #lkFindIn, #fontFind, .tlfind)`. В DOM ничего не размечается: роли ничего не
стоят и работают и для элементов, которые появляются позже (строки списков, меню, окна).

### Правила имён

* **Часть** — через точку: `player.volume` — часть плеера, `player.volume.slider` — часть громкости.
* **Разновидность** — через двоеточие: `search:global`, `search:library`, `tab:active`. Можно глубже:
  `search:global:artists`.
* Роль совпадает **со всеми своими разновидностями**: `[data-w="search"]` — любой поиск приложения, сколько бы их ни
  было и где бы они ни стояли. `[data-w="search:global"]` — только поиск по сервису. Части в роль не входят:
  `[data-w="player"]` — сама панель, а не её кнопки.
* **Роли, которой в приложении нет, правило просто не находит**: селектор с ней выбрасывается, остальные из того же
  списка через запятую остаются. Например, у клиента без кнопок справа в плеере нет `player.extra`, и правила для
  неё там ничего не делают и ничего не ломают.
* Поддерживается только `[data-w="…"]` (точное имя роли). `[data-w^=…]`, `[data-w~=…]` выбрасываются.

### Порядок и сила правил

1. CSS приложения;
2. `@@ css whisper-core` темы — общие правила по ролям;
3. `@@ css whisper-music` (секция этого приложения) — то, что нужно только здесь;
4. `tokens`, затем `colorOverrides` / «Тонкая настройка цветов» — главнее всего.

Роль разворачивается в `:is(…)`, поэтому у правила по роли сила самого сильного селектора роли (часто это id).
Чтобы перекрыть правило по роли в секции приложения, напишите там ту же роль (`[data-w="search:global"] { … }`)
или более точный селектор. Роли работают и в секции `whisper-music`.

### Словарь ролей

Словарь общий (`Whisper.ui.vocabulary()`), а соответствие элементам у каждого приложения своё. Приложение
может добавить свои разновидности и части (`search:global:artists`, `player.extra.timer`). Новые общие роли
добавляйте в `VOCAB` в ядре, чтобы их видели все приложения.

| Роль | Что это | В Whisper Yandex |
|---|---|---|
| `titlebar` | полоса заголовка окна | `.titlebar` |
| `titlebar.button` | кнопки окна (свернуть, развернуть, закрыть) | `.tbctl button` |
| `tabs` | полоса вкладок/закладок | `.tabs` |
| `tab` | вкладка | `.tabs .tab:not(.active)` |
| `tab:active` | открытая вкладка | `.tabs .tab.active` |
| `sidebar` | боковая панель (и всё, что оформляется как она) | `.side, .pinrail` (колонка закреплённых сбоку) |
| `nav` | кнопка боковой навигации | `.side .nav:not(.active)` |
| `nav:active` | текущий раздел | `.side .nav.active` |
| `search` | поле поиска (все виды) | все `search:*` ниже |
| `search:global` | поиск по всему сервису | `#search` |
| `search:library` | поиск по своей музыке/лайкам | `#lkFindIn` |
| `search:settings` | поиск в настройках и списках | `#fontFind, .tlfind` |
| `main` | средняя область со страницами | `.main` |
| `page.title` | заголовок страницы | `#title` |
| `page.subtitle` | строка под заголовком | `#sub` |
| `page.cover` | картинка в шапке страницы | `#headImg` |
| `button` | обычная кнопка в окне | `.main .nav:not(.active):not(.danger), .modalbox .nav:not(.active):not(.danger), .login-box .nav:not(.active):not(.danger)` |
| `button:active` | выбранная/главная кнопка | `.main .nav.active:not(.danger), .modalbox .nav.active:not(.danger), .login-box .nav.active:not(.danger)` |
| `button:danger` | опасное действие (удалить, выйти) | `.nav.danger` |
| `chip` | переключатель-«таблетка» (фильтры, вкладки страницы) | `.chip:not(.active)` |
| `chip:active` | выбранный переключатель | `.chip.active` |
| `tracklist` | список треков | `.list` |
| `track` | строка трека | `.list li[data-id]:not(.playing)` |
| `track:playing` | играющий трек в списке | `.list li[data-id].playing` |
| `track.cover` | обложка в строке | `.list li[data-id] > img` |
| `track.title` | название трека в строке | `.list li[data-id] .t` |
| `track.artist` | исполнитель в строке | `.list li[data-id] .a` |
| `track.like` | лайк в строке | `.list .likebtn` |
| `track.more` | «⋯» в строке | `.list .morebtn` |
| `card` | карточка/блок (настройки, статистика) | `.settings > .card, .stats .card` |
| `tile` | плитка альбома/плейлиста/артиста | `.simcard, .lastAlbum, .stperson, .stalbum` |
| `player` | нижняя панель плеера | `.player` |
| `player.cover` | обложка играющего трека | `#cover` |
| `player.title` | название играющего трека | `#pTitle` |
| `player.artist` | исполнитель играющего трека | `#pArtist` |
| `player.info` | блок с названием и исполнителем играющего трека | `.player .meta` |
| `player.like` | лайк в плеере | `#likeBtn` |
| `player.dislike` | «Не нравится» в плеере | `#disBtn` |
| `player.controls` | блок кнопок управления | `.player .ctrls` |
| `player.play` | пуск/пауза | `#play` |
| `player.prev` | предыдущий | `#prev` |
| `player.next` | следующий | `#next` |
| `player.mode` | повтор и перемешивание | `.player .modebtn:not(.on)` |
| `player.mode:on` | включённый повтор/перемешивание | `.player .modebtn.on` |
| `player.seek` | полоса воспроизведения | `#seek` |
| `player.time` | время трека | `.player .time` |
| `player.actions` | правый блок плеера | `.player .pright` |
| `player.extra` | дополнительные кнопки плеера (свои у каждого приложения) | `#togetherBtn, #sleepBtn` |
| `player.volume` | громкость (весь блок) | `#volWrap` |
| `player.volume.button` | кнопка громкости | `#volBtn` |
| `player.volume.slider` | ползунок громкости | `#vol` |
| `player.more` | «⋯» в плеере | `#pMore` |
| `radio` | кнопка/блок бесконечного потока («Моя волна», «VK Микс») | `.wavebtn` |
| `radio.stations` | выбор станции/настроения потока | `#stWrap` |
| `visualizer` | сцена визуализатора | `.stage` |
| `visualizer:fullscreen` | визуализатор на весь экран | `#vizFull` |
| `menu` | всплывающее меню | `.tmenu` |
| `menu.item` | пункт меню | `.tmenu .mi` |
| `toast` | всплывающая подсказка | `.toast` |
| `dialog` | окно-диалог | `.modalbox, .login-box` |
| `dialog.backdrop` | затемнение под окном-диалогом | `.modal` |
| `queue` | панель очереди | `.qpanel` |
| `fullplayer` | плеер на весь экран | `#full` |
| `fullplayer.seek` | полоса воспроизведения на весь экран | `#fSeek` |
| `fullplayer.prev` | «назад» на весь экран | `#fPrev` |
| `fullplayer.next` | «вперёд» на весь экран | `#fNext` |
| `lyrics` | текст песни | `#fLyrics` |
| `lyrics.line` | строка текста | `#fLyrics .ln:not(.on)` |
| `lyrics.line:active` | звучащая строка | `#fLyrics .ln.on` |

Модулям роли тоже полезны: `Whisper.ui.all("search")` возвращает все поля поиска в любом приложении, а
`Whisper.ui.has("player.extra")` говорит, есть ли такой элемент.

---

## Общие модули

Модули рядом с ядром (`src/core/`), которые работают **только** через `window.Whisper`. Их можно переносить в другое
приложение как есть.

Оформление модулей опирается на общие классы приложения (`.panel`, `.login.modal`, `.login-box`, `.modalbox`, `.field`,
`.nav`, `.row`, `.status`, `.switch`, `.chip`, `.lyrow`, `.lyseg`, `.slide`, `.card`, `.list`). У приложения без своих
таких стилей — `core/base.css` первой таблицей стилей: нейтральное тёмное оформление в `@layer whisper-base` и `:where()`,
поэтому любое правило приложения главнее. Whisper Yandex его не подключает — у него всё своё.

### `core/queue.js` + `core/queue.css` — очередь и история прослушивания

Выезжающая панель: «Сейчас играет», «Далее» (убрать, перетащить, «Показать ещё») и «История» по дням. Открывается
кнопкой в плеере, клавишей Q и кнопкой «История прослушивания» под выбором станций. Что модулю нужно от приложения:

* **Очередь** — `Whisper.queue.bind` с `upcoming`, `upcomingCount`, `label`, `remove`, `move`, `playNext`, `play`, `playAt`
  и сообщения `report({ queue })`, `report({ started })`, `report({ modes })`.
* **Роли:** `player.volume` (кнопка встаёт перед громкостью, иначе в `player.actions` / `player`), `radio.stations`
  (подписанная кнопка; нет роли — нет кнопки), `main` и `player` (где выезжать), `menu`, `dialog`, `dialog.backdrop`,
  `toast`, `titlebar` (щелчок по ним панель не закрывает), `fullplayer`, `visualizer:fullscreen` (тогда Q не работает).
* **Набор интерфейса** `Whisper.ui.provide({...})`. Без него модуль тоже работает, только проще:

| Функция | Что делает | Без неё |
|---|---|---|
| `toast(text, ms, { kind, action })` | всплывающая подсказка (с кнопкой «Вернуть») | `console.info` |
| `confirm({ title, text, ok, danger })` | окно-подтверждение → `Promise<boolean>` | `window.confirm` |
| `trackMenu(track, button)` / `closeMenu()` | меню «⋯» трека | кнопки «⋯» нет |
| `artists(el, track)` | исполнители (у Whisper Yandex — ссылки на артистов) | имена текстом |
| `image(src, cls)` | картинка (ленивая загрузка, заглушка) | обычный `<img>` |
| `decorateRow(li, track, before)` | свои значки в строке (например, «скачан») | — |
| `icon(name)` | значки `more`, `grip`, `plus` | встроенные `more`, `grip` |
| `menu(rawTrack, ctx)` | меню «⋯» для пунктов модулей (раздел «Меню трека для общих модулей») | пунктов модулей нет |
| `settingsCard(card, { section, first, colbreak })` | встроить карточку настроек модуля (`section`: `integrations`, `playback`, `sound`, `look`, `interface`, `app`; `colbreak` — с неё начинается правый столбец) | у модуля нет настроек |
| `accentColors()` | `{ accent, accent2 }` текущего стиля строго `#rrggbb` (виджет OBS) | цвета по умолчанию |
| `obsTheme()` | `{ key, css, settings }` — секции `whisper-obs` текущего стиля; `key` меняется со стилем | виджет без оформления стиля |
| `rangeFill(input)` | перерисовать заливку ползунка, если приложение рисует её само | — |
| `secretSaved()` | ключ только что сохранён (предупредить, если хранилище незащищённое) | — |

* **Хранилище:** история лежит в `localStorage` под ключом `<storage>history`, приставку задаёт `Whisper.setApp({ storage })`.
  У Whisper Yandex это `ym_`, то есть прежний ключ `ym_history`, поэтому старая история сохранилась. О треке сохраняется то,
  что вернёт `provider.store(raw)` (у Яндекса это короткое описание `trackMin`). Нет метода — сохраняется `raw` целиком.

Старые имена для совместимости: `window.playNext(rawTrack, quiet)` (меню трека, консоль, «Слушать вместе»)
и `window.qToggle()`.

### `core/archive.js` + `core/archive.css` — Whisper Archive

Свой архив вместо версий сервиса: модуль собирает список треков из альбомов владельца ключа и, когда приложение
включает трек, ищет в нём трек с тем же названием и исполнителем (`feat.`, «Исполнитель - Название» в имени файла,
`ё/е` не мешают). Нашёлся — играет поток из архива и на обложке появляется печать «WA». Ещё в модуле: вход по почте
(код из письма), API-ключ вручную, карточка в настройках, «Сохранить в архив» в меню трека.

Что нужно от приложения:

* **Rust-папка `src/core/rust/whisper/`** (общая для всех приложений Whisper, приходит подмодулем): команды
  `wa_token_exists/set/clear`, `wa_me`, `wa_albums_mine`, `wa_album`, `wa_album_share` (ссылка на свой альбом; у приватного — приглашение), `wa_invite_open` (открыть чужой приватный
  альбом по ключу приглашения: лайк с cookie приглашения — и альбом доступен ключу приложения), `wa_stream` (в `whisper::`), `wa_auth_request_code`,
  `wa_auth_issue` (`whisper::auth::`), `wa_prefetch` (`whisper::stream::`) и протокол `wa://`
  (в `lib.rs` — `register_asynchronous_uri_scheme_protocol("wa", …)` → `whisper::stream::serve_stream`), плюс разрешения в
  `build.rs` и `capabilities`. Своё у приложения — только `src-tauri/src/whisper_host.rs` (образец — `rust/whisper_host.example.rs`): где лежит ключ (`token_get/set/clear`),
  общий семафор больших файлов (`heavy_slot`), Origin своих окон (`app_origin`) и подпись ключа (`DEVICE_NAME`).
* **Плеер:** спрашивать `Whisper.sources.resolve(track, next)` перед загрузкой трека и сообщать `report({ source })`.
  Если поток `wa://` не заиграл, использовать `hit.blob()`.
* **Роль `player.cover`** — на ней печать «WA» (обложка оборачивается в `span.wacov`, обработчики клика остаются).
* **Набор интерфейса:** `settingsCard` (без него нет карточки настроек), `menu` (без него нет «Сохранить в архив»),
  `toast`, `closeMenu`, `secretSaved`, `icon("plus")`.
* **«Сохранить в архив»** — у провайдера: `archiveSave(track, { fileName, albumId, albumTitle, coverUrl, coverBytes })`
  → ответ `{ status, body }`. Файл трека должен взять сам сервис. У Яндекса это Rust-команда `wa_save_track`
  (`whisper_yandex.rs`): она скачивает mp3 и обложку с Яндекса по номеру трека, а отправляет в архив общий
  `whisper::upload`. У другого сервиса нужна своя такая команда — примерно 30 строк (ниже). Нет метода — нет пункта в меню.

  ```rust
  // whisper_vk.rs — порядок важен: бюджет и ключ проверяются ДО скачивания из сервиса
  let up = whisper::upload::begin(album_id.as_deref(), cover_bytes.as_ref().map(|b| b.len()))?;
  let audio = /* скачать трек из своего сервиса по его id */;
  if audio.len() > whisper::upload::MAX_TRACK_UPLOAD { return Err("трек больше 100 МБ".into()); }
  let track = whisper::upload::TrackFile::new(&file_name, &audio).ok_or("неизвестный формат")?;
  if let Some(id) = album_id { return up.to_album(&id, track).await; }
  let title = whisper::upload::album_title(album_title.as_deref())?;
  up.new_album(&title, &cover, track).await
  ```
* Окно входа использует общие классы оформления: `.login.modal`, `.panel.login-box.modalbox`, `.field`, `.nav`, `.row`,
  `.status`. В другом приложении их стоит оформить или переопределить `.wamodal`.

API для других модулей: `Whisper.modules.archive` — `login(reason)`, `enabled()`, `connected()`, `lookup(track)`, `sync()`.
Старое имя `window.waLogin` оставлено: им пользуется «Слушать вместе».

### `core/together.js` + `core/together.css` — «Слушать вместе»

Комнаты через сервер Whisper Archive. Ведущий создаёт комнату, его трек, позиция, пауза и скорость уходят на сервер.
Гости ждут изменений (long-poll) и включают то же самое у себя, каждый со своего аккаунта сервиса. Позиция
выравнивается по времени сервера. Гость может отойти (пауза или свой трек) и вернуться. Гости предлагают треки, ведущий
включает их, ставит следующими (или автоматически, «Ставить в очередь») и может передать управление. Ещё в модуле:
приглашение по ссылке `whisper://room/КОД`, ярлык «Ты ведущий / гость · КОД» под названием трека, окно комнаты.

Что нужно от приложения:

* **Плеер:** `bind` с `play`, `pause`, `toggle`, `seek` (и когда длина ещё неизвестна), `setRate`, `playTrack`, `reload`,
  `media`. Сообщения `report({ track, playing, seek, rate, audible })`. Свой «загрузить без звука» (hold): гость
  готовит трек, пока ведущий его грузит. Перед тем как стартовать такой трек, плеер спрашивает
  `Whisper.modules.together.wantsPlay()`: если ведущий уже играет, держать трек не нужно.
* **Очередь:** `playNext` (предложения «Следующим»). Перед переходом к следующему треку плеер зовёт
  `Whisper.modules.together.take()`, чтобы режим «Ставить в очередь» успел поставить предложение.
* **Роли:** `player.actions` (кнопка, если приложение не поставило свою `#togetherBtn`), `player.info` (ярлык комнаты),
  `player.next`, `player.prev`, `fullplayer.next`, `fullplayer.prev`, `player.mode` (у гостя не работают),
  `player.seek`, `fullplayer.seek` (у гостя возвращают к ведущему).
* **Набор интерфейса:** `toast`, `confirm`, `menu` (блок «Слушать вместе · КОД» сверху меню трека, `slot: "top"`).
* **Провайдер:** `toRoom(track)` → трек в формате сервера `{ id, albumId, title, version, artists, coverUri, durationMs }`,
  `fromRoom(obj)` → трек сервиса. Ещё `accountLabel` для текста «каждый слушает со своего …». Модуль сам дописывает
  к треку `provider` (id провайдера). Для сопоставления нужны `tracks(ids)` (с `available`) и `search(text, "track")`.
* **Смешанные комнаты и треки, которых нет** («мягкая связь»). Гость выясняет, что у него значит трек комнаты:
  тот же сервис и трек доступен — номер как есть; иначе поиск на своём сервисе (название, общий исполнитель, та же версия,
  длина ±15 с); иначе свой Whisper Archive; иначе трека нет. Тогда гость шлёт `/missing` и ждёт на паузе. Ведущий видит
  `room.missing`. С галочкой «Делиться треками, которых нет у гостей» (localStorage `ym_room_share`) он зовёт
  `provider.roomCache(track, code)`: файл уходит во временный кэш комнаты на сервере архива (`POST /api/rooms/{code}/cache`,
  ответ `{ id }`). Файл живёт, пока открыта комната, и не дольше 30 минут после того, как последний раз играл; до 8 файлов
  и 400 МБ на комнату. С дополнительной галочкой «Сохранять их в мой архив» (`ym_room_share_save`) — или если у провайдера
  нет `roomCache` — вместо этого `Whisper.modules.archive.share(track)`: трек ложится в приватный альбом «Слушать вместе».
  Трек уже есть в архиве ведущего — отдаётся он, без загрузки. Если `provider.localOnly(track)` — true (трек есть только
  у ведущего, например своя обрезанная версия), ведущий делится сразу, без галочки. В любом случае id уходит гостям как `archiveId`,
  и у гостя трек играет по `/api/tracks/{id}/stream`: сервер отдаёт либо трек архива, либо файл кэша комнаты. Так же «нет у меня» — если трек комнаты не заиграл с сервиса
  (ошибка плеера при источнике `provider`). Предложения гостей ведущий сопоставляет со своим сервисом так же.
* **Статус позванных друзей.** В снимке комнаты (для участников) — `room.invited: [{ userId, status, at }]`, где `status` —
  `pending` (позван), `declined` (отклонил), `expired` (не ответил). Кто уже вошёл — его нет в `invited`, он в `members`.
  Окно показывает «В комнате / Позван ✓ / Отклонил / Не ответил» только в комнате: вышел — у всех снова «Позвать».
  У друга есть `app` — id провайдера его приложения (`yandex`, `vk`…; приложение сообщает его в `wa_room_invites(since, app)`),
  рядом с ником — название (`APP_LABEL` в together.js; новое приложение — добавь туда).
* **Темы комнаты** — модуль справа от окна. «Поделиться моей темой» берёт `kit.themeExport()` → `{ id, name, author, bytes }`
  (текущий стиль файлом .wmt) и отдаёт `wa_room_theme_share` сырыми байтами с заголовками `x-room-code`, `x-theme-name`,
  `x-theme-author` (percent-encoded) → `POST /api/rooms/{code}/themes`. Список — `room.themes: [{ id, name, author, from, mine, size, at }]`;
  «Установить» — `wa_room_theme_get(code, id)` (байты) → `kit.themeImport(bytes)` (true / false / null — отказался заменить);
  «✕» — свою или (у ведущего) любую: `wa_room_theme_remove`. До 8 тем и 160 МБ на комнату, файл ≤ 64 МБ; та же тема от того же
  человека заменяет прежнюю; живут, пока открыта комната. Новая чужая тема — подсказка с кнопкой «Установить».
  Нет `themeExport` / `themeImport` у приложения — кнопки неактивны.
* **«Подмигнуть»** — знак участнику без голоса: «😉» у каждого в «Участниках» (и «всем» в заголовке, если слушателей
  больше одного) → ряд знаков `wink next prev pause play louder quieter like` → `wa_room_wink(code, to?, kind)` →
  `POST /api/rooms/{code}/wink { to?, kind }` (не чаще раза в 2 с от одного человека, иначе 429). В снимке получателя —
  `room.winks: [{ id, from, fromId, all, kind, at }]` за последнюю минуту; каждый показывается один раз (по id),
  те, что были до входа, — нет. Текст рисует получатель (`WINKS` в together.js), сервер передаёт только вид знака.
  Ведущему на просьбу про музыку в подсказке есть кнопка («Переключить», «На паузу», «Громче»…), кнопка комнаты в плеере
  коротко подпрыгивает (`.togetherbtn.wink`).
* **Системные уведомления** — `kit.notify({ kind: "invite" | "wink", title, body })` → Promise<bool>: приглашение
  друга (`onInvite`) и подмигивание. Показывать ли (выключатели, «только когда окно в фоне») решает приложение;
  у Whisper Yandex — notify.js + notify.rs (tauri-plugin-notification), настройки «Приложение → Уведомления».
  Нет `kit.notify` — только подсказка в окне.
* **Пинг** виден только в окне комнаты (свой — под кодом, у участников — в «Участниках»): в плеере строки пинга нет.
  Трек долго грузится из-за плохой связи — одна подсказка «Трек грузится долго…» (не чаще раза в 2 минуты).
* **Rust:** команды `wa_room_create / get / join / leave / state / suggest / dismiss / transfer / ping / missing / wink` (`whisper::rooms::`),
  для кэша комнаты — `upload::begin(None, None)?.to_room_cache(code, TrackFile)` в своей команде приложения
  (у Whisper Yandex — `wa_room_cache_track` в whisper_yandex.rs: скачивает трек с Яндекса и отдаёт в кэш), и
  `room_link_take` + событие `room-link` (deeplink.rs, ссылки `whisper://room/…`).
* **Оформление** — `core/together.css`: кнопка в плеере `.togetherbtn` (на `::after` — сколько слушают), ярлык комнаты
  `.roomtab` (`.host` / `.guest` / `.away`), блок в меню `.mroom`, окно `.rm*`, анимации `rtLive`, `rtAway`, `rmSugPulse`, все
  четыре встроенных стиля. Файл подключают **сразу после** общего оформления приложения: селекторы рассчитаны на то, чтобы
  перекрыть его правила плеера (`.player .meta …`) и меню (`.tmenu …`). В приложении с другой разметкой поправь начало
  селекторов. Окно ещё использует общие классы оформления (`.login.modal`, `.modalbox`, `.nav`, `.field`, `.switch`,
  `.row`, `.status`). Состояние модуль ставит классами на `body`: `in-room`, `room-guest`, `room-away`. Ими приложение
  оформляет своё: у Whisper Yandex в `styles.css` остались затемнённые «вперёд/назад» у гостя и страница «Моя волна» у гостя.

API: `Whisper.modules.together` — `info()` (`{ code, host, follow }` | `null`), `wantsPlay()`, `take()`, `open()`, `create()`,
`join(code)`, `leave()`, `suggest(track)`, `rejoin()`, `room()`, `waveBtn()` / `stBtn()` (кнопки бесконечного потока у гостя).
Старые имена для `main.js` и консоли: `window.roomInfo`, `window.roomWantsPlay`, `window.roomTake`, `window.roomCli`.

### `core/discord.js` + `core/discord.css` — Discord Rich Presence

«Слушает …» в профиле Discord: трек, исполнитель, альбом, обложка, полоска времени (с учётом скорости), кнопка
«Скачать …». Карточка в настройках (переключатель, состояние подключения, «Настроить…») и окно с превью и параметрами.
Discord сам находит запущенный клиент и переподключается — это делает Rust.

Что нужно от приложения:

* **Плеер:** `Whisper.player.watch` (сообщения о треке, паузе, перемотке) и `Whisper.player.media()` с полями `has`,
  `time`, `rate`, `buffering`, `error` — по ним модуль понимает, что звук на самом деле стоит (загрузка, буферизация,
  ошибка сети), и показывает в Discord паузу, а не бегущее время. Без этих полей модуль работает, но зависание не заметит.
* **Набор интерфейса:** `settingsCard` (карточка, у Whisper Yandex — правый столбец «Интеграций»). Окно использует общие
  классы `.login.modal`, `.panel.login-box.modalbox`, `.switch`, `.nav`, `.row`.
* **Rust:** `rust/discord.rs` (`#[path = "../../src/core/rust/discord.rs"] mod discord;`), команды `discord_config`,
  `discord_status`, `discord_retry`, `discord_update` и событие `discord-status`. В `whisper_host.rs` — `DISCORD_APP_ID`
  (своё приложение Discord: его название видно в «Слушает …»), `DISCORD_BUTTON`, `APP_URL`.
* **Хранилище:** настройки — `<storage>discord` (у Whisper Yandex — `ym_discord`).

### `core/obs.js` + `core/obs.css` — виджет «Сейчас играет» для OBS

Маленький сервер на `127.0.0.1` (Rust) отдаёт страницу виджета для источника «Браузер» в OBS. Карточка в настройках:
адрес с ключом, вид (как в стиле / карточка / компактный / полоска), прозрачность, «прятать на паузе». Оформление
виджета под стиль — секции `@@ css whisper-obs` и `@@ settings whisper-obs` темы (`docs/WMT-FORMAT.md`).

Что нужно от приложения:

* **Плеер:** `Whisper.player.watch` + `Whisper.player.state()`; основа стиля — `data-base` на `<html>`.
* **Набор интерфейса:** `settingsCard`, `accentColors` (цвета `#rrggbb`), `obsTheme` (секции whisper-obs текущего
  стиля — из `WhisperThemeCss.obsCss(th)`), `rangeFill`, `toast`. Классы карточки: `.switch`, `.slide`, `.chip`,
  `.lyrow`, `.lyseg`, `.field`, `.nav`, `.status`.
* **Rust:** `rust/obs.rs` (+ страница `rust/obs/widget.html`, `widget.js`), команды `obs_config`, `obs_state`, `obs_theme`.
  В `whisper_host.rs` — `OBS_IMG_SRC` (CSP картинок страницы) и `cover_ok(url)` (какие обложки можно отдать виджету).
  Порты 47821–47826: если первый занят (например, второе приложение Whisper), берётся следующий.
* **Хранилище:** `<storage>obs` (у Whisper Yandex — `ym_obs`).

## Движок тем: `core/wmt.js` + `core/theme-css.js`

Оба файла — чистые модули без DOM и без зависимостей от приложения (работают в браузере и в Node 18+).
`core/wmt.js` — формат файла (`window.WMT`, описание — `docs/WMT-FORMAT.md`). `core/theme-css.js` — что делать с CSS
темы: `window.WhisperThemeCss`. В Node проекта с `"type": "module"` оба подключаются через `await import(…)` и
кладут себя в `globalThis` (`globalThis.WMT`, `globalThis.WhisperThemeCss`).

```js
const th = await WMT.open(bytes);                                    // текст или архив
const { css, urls } = WhisperThemeCss.themeCss(th, "chalk", "whisper-vk", {
  // все поля необязательны
  core: "whisper-core",            // имя общей секции ролей
  resolve: (sel) => …,             // роли → селекторы; по умолчанию Whisper.ui.resolve (если ядро подключено)
  mutedIn: ":is(.card, .list)",    // блоки, где приложение само переопределяет --muted: цвет темы там тоже главнее
});
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheetFrom(css)];   // или свой способ подключения
// когда тема больше не нужна: urls.forEach(URL.revokeObjectURL)
const obs = WhisperThemeCss.obsCss(th);                              // { css, settings } для виджета OBS
```

`themeCss` делает всё по порядку: `@@ css whisper-core` → `@@ css <app>` → значения из `tokens`; `url(asset:…)` →
`blob:`; затем `scopeCss` — привязка к стилю и фильтр безопасности. Отдельные функции тоже доступны:

| Функция | Что делает |
|---|---|
| `scopeCss(css, id, allowed?, { resolve }?)` | правила темы → правила стиля `id` (`:root[data-style="id"] …`); `allowed` — адреса, которые можно оставить в `url()` |
| `cssSafe(text, allowed)` | можно ли оставить кусок CSS (после раскрытия `\`-экранирования, без комментариев) |
| `extractFrom(css, style)` | обратная операция: правила встроенного стиля из CSS приложения уже без привязки («Сохранить стиль в файл») |
| `tokensCss(tokens, { mutedIn }?)` | CSS из `tokens`: `--text`, `--muted`, `--font-display`, шрифт и фон `body` |
| `cssVal(v)` | значение из чужого файла, которое можно подставить в CSS, или `""` |
| `withAssets(css, th, make)` | `url(asset:имя)` → `url("<make(ресурс)>")`, пустой адрес → `none` |
| `obsCss(th)` | секция виджета OBS: ресурсы — `data:` (до 1,5 МБ), всё, что ведёт наружу, вырезано |
| `cssParse`, `splitTop`, `splitDecls`, `scopeSel`, `ruleText`, `unesc` | разбор CSS, на котором всё построено |

Что гарантирует привязка (одинаково во всех приложениях):

* тема не ходит в сеть: `@import`, `url()` куда-либо, кроме своих ресурсов, `data:` и `#якорей`, `image-set()` и подобные
  выбрасываются вместе с объявлением;
* `@keyframes`, `@font-face` и `@layer` темы получают префикс `wmt-<id>-`: тема не подменяет анимации, шрифты и слои
  приложения; `@property`, `@page` и прочие @-правила не поддерживаются;
* сдвиги и увеличение при `:hover`/`:active` действуют только при `:root[data-anim="on"]`;
* селектор с ролью, которой у приложения нет, выбрасывается (раздел «Роли интерфейса»).

Соглашения для приложения: выбранный стиль — атрибут `data-style` на `<html>`, анимации — `data-anim="on|off"` там же;
свои слои и анимации не называть с `wmt-`.

---

## Как подключить ядро в другом приложении (например, Whisper VK)

1. Добавить ядро подмодулем: `git submodule add https://github.com/Whisper-Music/whisper-core.git src/core`
   (`frontendDist` в `tauri.conf.json` — папка `src`) и подключить ядро первым скриптом:
   `<script src="core/whisper-core.js" defer>` до кода приложения.
2. Сразу после кода приложения (и **до** движка тем) подключить свой файл привязки (как `yandex.js` здесь):
   * `Whisper.setApp({ id: "whisper-vk", name: "Whisper VK" })` — id нужен для секции темы `@@ css whisper-vk`;
   * `Whisper.ui.define({...})` — свои селекторы для ролей из словаря (не обязательно все);
   * `Whisper.registerProvider({...})` — `caps` и методы, которые есть у VK;
   * `Whisper.player.bind({...})`, `Whisper.queue.bind({...})`.
3. В коде плеера вызывать `Whisper.player.report({...})` в тех же местах: смена трека, пуск/пауза, громкость,
   лайк, перемотка, изменение очереди.
4. Движок тем: подключить `core/wmt.js` и `core/theme-css.js` и подключать тему одним вызовом
   `WhisperThemeCss.themeCss(th, id, "whisper-vk")` (раздел «Движок тем» выше): роли, безопасность и порядок секций
   уже внутри. У приложения остаётся только своё: где хранить темы, как включать стиль (`data-style` на `<html>`),
   фон и карточки стилей.

5. Whisper Archive и «Слушать вместе» (Rust): в `src-tauri/src/lib.rs`
   ```rust
   #[path = "../../src/core/rust/whisper/mod.rs"]
   mod whisper;
   mod whisper_host;   // своё: скопировать rust/whisper_host.example.rs и поправить
   ```
   и зарегистрировать команды (`whisper::wa_*`, `whisper::auth::*`, `whisper::stream::*`, `whisper::rooms::*`) в
   `generate_handler!`, `build.rs` и `capabilities`, протокол `wa` → `whisper::stream::serve_stream`.
   «Сохранить в архив» — своя команда со скачиванием из своего сервиса (пример выше, раздел про `core/archive.js`).

Темы, написанные по ролям, после этого одинаково выглядят в обоих приложениях. Классы и раскладка внутри
приложений при этом могут быть совсем разными.

---

## Что дальше

Сейчас ядро — фасад над работающим `main.js`. Перенос делается по кусочку, без поломок:

* ~~перевести мини-плеер, OBS, Discord и «Слушать вместе» с крючков `window.miniPush` / `window.discordPush` на ядро~~ —
  сделано: `Whisper.player.watch`; `traymini.js` и `obs.js` берут «что играет» только из `Whisper.player.state()`.
* ~~очередь и история — на ядро, общим модулем~~ — сделано: `core/queue.js`, крючков `window.qRefresh` / `window.qOnPlay` больше нет;
* ~~Whisper Archive — частью ядра~~ — сделано: источники звука (`Whisper.sources`), `core/archive.js`, меню трека для модулей;
* ~~«Слушать вместе» — общим модулем~~ — сделано: `core/together.js`, `playTrack` / `reload` / `media` в плеере ядра;
* ~~стили «Слушать вместе» — в `core/together.css`~~ — сделано;
* страницы `main.js` — на методы провайдера вместо прямых `ym(…)`;
* ~~движок тем — в ядро~~ — сделано: `core/wmt.js` и `core/theme-css.js`, в `theme.js` осталось только своё для этого приложения;
* ~~разделить `whisper.rs` на общую часть (архив, комнаты) и часть Яндекса~~ — сделано: `src-tauri/src/whisper/` + `whisper_yandex.rs`;
* ~~вынести `src/core` в отдельный репозиторий~~ — сделано: whisper-core, подмодуль в `src/core` у каждого приложения;
* ~~Discord и виджет OBS — в ядро~~ — сделано: `core/discord.js`, `core/obs.js`, `rust/discord.rs`, `rust/obs.rs`;
* статистика прослушиваний — в ядро.
