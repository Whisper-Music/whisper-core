// Только темы .wmt, без DOM: разбор и сборка (WMT) и движок CSS (WhisperThemeCss). Работает в Node 18+ и в браузере.
import "./wmt.js";
import "./theme-css.js";

export const WMT = globalThis.WMT;
export const WhisperThemeCss = globalThis.WhisperThemeCss;
export default { WMT, WhisperThemeCss };
