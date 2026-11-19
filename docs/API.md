# Whisper API — локальная API приложений Whisper

Программы Whisper на одном компьютере (клиенты Yandex и VK, Whisper Mixer и следующие) управляют друг другом
и дают свои функции системе: например, микшер одной кнопкой ставит тему во все клиенты. Rust — `rust/api.rs`,
страница — `api.js`. Версия протокола — `1` (`API` в api.rs, `WhisperApi.VERSION`).

## Как найти приложения: реестр

Каждое запущенное приложение слушает `127.0.0.1` на свободном порту и пишет о себе файл `<id>.json`:

| Система | Папка реестра |
|---|---|
| Windows | `%LOCALAPPDATA%\Whisper\api\` |
| Linux | `$XDG_RUNTIME_DIR/whisper-api/`, без неё — `~/.cache/whisper/api/` |

```json
{ "api": 1, "id": "whisper-music", "name": "Whisper Yandex", "version": "1.2.2",
  "port": 53817, "pid": 1234, "key": "<32 hex>", "caps": ["GET theme", "GET theme/file", "POST theme"] }
```

- `id` — как `Whisper.setApp({ id })` (= секция темы): `whisper-music`, `whisper-vk`, `whisper-mixer`.
- Порт и ключ новые при каждом запуске. При выходе файл удаляется; если приложение упало, файл остаётся —
  первый же клиент, которому порт ответит «соединение отклонено», удалит его.
- На Unix папка 0700, файлы 0600; клиент читает только свои (владелец — текущий пользователь) файлы,
  у которых имя совпадает с `id`.

## Запрос

```
METHOD /v1/<имя>[?строка] HTTP/1.1
Host: 127.0.0.1:<port>
Authorization: Bearer <key>
Content-Length: <длина тела>
```

- Только `GET` и `POST`, только `Content-Length` (без chunked), тело ≤ 64 МБ.
- Отклоняются: чужой `Host` (421), любой `Origin` — запросы браузера (403), неверный ключ (401).
- Ответ — JSON `{ "ok": true, … }` / `{ "ok": false, "error": "…" }` или байты (`application/octet-stream`).
- `504` — приложение не ответило за 20 с (например, спрашивает пользователя «Заменить стиль?»; тема всё равно
  применится, когда он ответит).

## Действия (caps)

| Действие | Тело / ответ |
|---|---|
| `GET info` | всегда есть, отвечает сам Rust: `{ api, id, name, version, caps }` |
| `POST theme` | тело — файл `.wmt` (текст или zip). Установить и включить, как «Загрузить тему…». `409` — пользователь отказался заменять тему с тем же id, `422` — тема не подошла |
| `GET theme` | `{ id, name, author, size }` текущего стиля |
| `GET theme/file` | текущий стиль файлом `.wmt` |

Приложение объявляет только то, что умеет (`caps` в реестре и в `GET info`). Новое действие — обработчик
на странице (`WhisperApi.handle`), Rust менять не нужно.

## Со страницы: `window.WhisperApi` (`Whisper.modules.api`)

```js
WhisperApi.handle("POST theme", async (req) => {   // req: { cap, query (URLSearchParams), size, body(), json() }
  const bytes = await req.body();                   // Uint8Array
  return { ok: true };                              // объект → JSON 200; Uint8Array → байты
  // return WhisperApi.reply(409, { ok: false, error: "…" })  — свой код ответа
});
WhisperApi.start({ id: "whisper-mixer", name: "Whisper Mixer", version: "0.1.0" }); // без ядра; с ядром — само

await WhisperApi.apps();                        // [{ id, name, version, caps }] — кроме себя
await WhisperApi.sendTheme(bytes, { to: [] });  // [{ id, name, status, ok, reply, error }] — всем, кто умеет POST theme
await WhisperApi.send("POST x", data, { to: ["whisper-vk"], query: "a=1" });
await WhisperApi.themeOf("whisper-music");      // Uint8Array — текущая тема другого приложения
WhisperApi.setEnabled(false);                   // выключатель «Связь с приложениями Whisper» (<storage>api)
```

С ядром (`whisper-core.js` подключён раньше) модуль сам берёт `id`/название из `Whisper.app`, темы — из набора
интерфейса (`kit.themeImport` / `kit.themeExport`, как у «Тем комнаты») и ставит карточку «Приложения Whisper»
(`kit.settingsCard`, раздел `look`): выключатель, список соседей, кнопка «Стиль — во все приложения».

## Подключение

- `index.html`: `<script src="core/api.js">` — после кода приложения и его `ui.provide` (нужны `themeImport/themeExport`),
  рядом с другими модулями ядра.
- `lib.rs`: `#[cfg(desktop)] #[path = "../../src/core/rust/api.rs"] mod api;`, команды `api::wapi_start, wapi_stop,
  wapi_body, wapi_reply, wapi_apps, wapi_send, wapi_fetch` — в `generate_handler!`, `build.rs` и capabilities
  (`allow-wapi-…`), плюс `core:event:allow-listen` для окна; в `RunEvent::Exit` — `api::shutdown()`.
- Библиотеки: `tauri` 2, `serde`, `serde_json`, `getrandom` 0.3, под `cfg(unix)` — `libc`. От `whisper_host` api.rs
  не зависит — подключается и в программу без остального ядра.

## Из системы (скрипт, ярлык, другая программа)

PowerShell — поставить тему во все запущенные приложения Whisper:

```powershell
$wmt = [IO.File]::ReadAllBytes("D:\themes\gothic.wmt")
Get-ChildItem "$env:LOCALAPPDATA\Whisper\api\*.json" | ForEach-Object {
  $a = Get-Content $_ -Raw | ConvertFrom-Json
  if ($a.caps -contains "POST theme") {
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($a.port)/v1/theme" `
      -Headers @{ Authorization = "Bearer $($a.key)" } -Body $wmt -ContentType "application/octet-stream"
  }
}
```
