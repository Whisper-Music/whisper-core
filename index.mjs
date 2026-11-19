// Whisper Core для сборщиков (Vite, webpack, esbuild…): import { Whisper, WhisperEmbed } from "whisper-core".
// Файлы ядра — обычные скрипты (так их подключает Whisper Yandex без сборки): они ставят window.Whisper, WMT,
// WhisperThemeCss, WhisperEmbed, а этот файл только подключает их по порядку и отдаёт наружу.
// Нужен браузер (window, document). Для Node и скриптов без DOM — "whisper-core/themes".
// Общие модули подключаются отдельно и после своей привязки к ядру: import "whisper-core/queue.js"; import "whisper-core/queue.css".
import "./whisper-core.js";
import "./wmt.js";
import "./theme-css.js";
import "./embed.js";

const g = globalThis;
export const Whisper = g.Whisper;
export const WMT = g.WMT;
export const WhisperThemeCss = g.WhisperThemeCss;
export const WhisperEmbed = g.WhisperEmbed;
export default Whisper;
