// Типы Whisper Core для своих приложений (TypeScript, подсказки в редакторе). Подробно — docs/CORE.md и docs/EMBED.md.
// Здесь — то, что нужно для встраивания: шина, плеер, роли, хост, темы. Остальное ядра — тоже есть, но описано в CORE.md.

export interface WhisperTrack { id: string; title: string; artists?: { id?: string; name: string }[]; album?: { id?: string; title?: string }; duration?: number; cover?: string; [k: string]: unknown }

export interface WhisperHost {
  kind?: string;
  invoke?(cmd: string, args?: unknown, opts?: unknown): unknown;
  listen?(event: string, fn: (e: { event: string; payload: unknown }) => void): unknown;
  fileUrl?(path: string, scheme?: string): string;
  openUrl?(url: string): unknown;
  attention?(): unknown;
}

/** "--переменная" или "селектор { свойство }"; можно массив. Ключи — "color.accent", "effects.glow"… */
export type TokenMap = Partial<Record<
  "color.accent" | "color.accent2" | "color.text" | "color.muted" | "color.background" |
  "effects.glow" | "effects.panelOpacity" | "effects.dim" | "effects.backgroundBlur" | "font.body" | "font.display",
  string | string[]>>;

export interface Coverage { used: string[]; have: string[]; missing: string[]; ratio: number }

export interface WhisperApi {
  readonly version: string;
  readonly app: { id: string; name: string; version: string; storage: string };
  setApp(o: { id: string; name?: string; version?: string; storage?: string }): void;
  on(event: string, fn: (payload: any) => void, opts?: { replay?: boolean }): () => void;
  once(event: string, fn: (payload: any) => void): () => void;
  off(event: string, fn: (payload: any) => void): void;
  emit(event: string, payload?: unknown): void;
  registerProvider(p: { id: string; caps?: Record<string, boolean>; [k: string]: unknown }): void;
  caps(name: string): boolean;
  player: {
    bind(h: Record<string, (...a: any[]) => any>): void;
    report(r: { track?: unknown; playing?: boolean; volume?: number; liked?: boolean; disliked?: boolean; seek?: boolean; rate?: number; modes?: unknown; queue?: boolean; started?: boolean; source?: string; audible?: boolean }): void;
    watch(fn: (force: boolean) => void): () => void;
    state(): Record<string, unknown>;
    [k: string]: any;
  };
  queue: { bind(h: Record<string, (...a: any[]) => any>): void; [k: string]: any };
  sources: { register(s: { id: string; priority?: number; resolve(track: WhisperTrack, next?: WhisperTrack): any }): void; [k: string]: any };
  ui: {
    define(map: Record<string, string>): void;
    provide(kit: Record<string, (...a: any[]) => any>): void;
    resolve(selectorList: string): string;
    selector(role: string): string;
    has(role: string): boolean;
    all(role: string, root?: ParentNode): Element[];
    roles(): Record<string, string>;
    vocabulary(): Record<string, string>;
    coverage(roles: string[]): Coverage;
    tokens(map: TokenMap | null): void;
    tokenMap(): TokenMap | null;
    [k: string]: any;
  };
  host: {
    kind(): string;
    has(fn: keyof WhisperHost): boolean;
    invoke<T = unknown>(cmd: string, args?: unknown, opts?: unknown): Promise<T>;
    listen(event: string, fn: (e: { event: string; payload: any }) => void): Promise<() => void>;
    fileUrl(path: string, scheme?: string): string;
    openUrl(url: string): Promise<void>;
    attention(): void;
  };
  setHost(h: WhisperHost | null): void;
  modules: Record<string, any>;
  [k: string]: any;
}

export interface WmtTheme {
  version: number;
  manifest: { id: string; name: string; author?: string; base?: string; apps?: string[]; [k: string]: unknown };
  tokens: { color?: Record<string, string>; effects?: Record<string, number>; font?: Record<string, string>; [k: string]: unknown };
  assets: Map<string, { name: string; mime: string; bytes: Uint8Array }>;
  archive: boolean;
  background: { name: string; mime: string; bytes: Uint8Array } | null;
  css(app: string): string | null;
  settings(app: string): Record<string, unknown>;
  asset(ref: string): { name: string; mime: string; bytes: Uint8Array } | null;
}

export interface WMTApi {
  VERSION: number;
  open(input: string | Uint8Array | ArrayBuffer): Promise<WmtTheme>;
  parse(text: string): WmtTheme;
  pack(theme: Record<string, unknown>): Promise<Uint8Array>;
  serialize(theme: Record<string, unknown>): string;
  WmtError: new (msg: string, line?: number) => Error & { line: number };
  [k: string]: any;
}

export interface ThemeCssApi {
  VERSION: string; CORE: string;
  themeCss(th: WmtTheme, id: string, app: string, opts?: { core?: string; resolve?: (s: string) => string; mutedIn?: string; extra?: string; tokenMap?: TokenMap | true }): { css: string; urls: string[] };
  tokensMapCss(tokens: WmtTheme["tokens"], map?: TokenMap | true, opts?: { mutedIn?: string }): string;
  TOKEN_MAP: TokenMap;
  rolesUsed(th: WmtTheme, app?: string): string[];
  scopeCss(css: string, id: string, allowUrls?: Set<string>, opts?: Record<string, unknown>): string;
  [k: string]: any;
}

export interface AppliedTheme { id: string; manifest: WmtTheme["manifest"]; roles: string[]; coverage: Coverage; bg: { url: string; mime: string } | null; remove(): boolean }

export interface EmbedApi {
  VERSION: string;
  applyTheme(input: string | Uint8Array | ArrayBuffer | WmtTheme, opts?: { app?: string; map?: TokenMap | true; slot?: string; root?: HTMLElement; anim?: boolean; background?: string | HTMLElement; extra?: string }): Promise<AppliedTheme>;
  inspect(input: string | Uint8Array | ArrayBuffer | WmtTheme, opts?: { app?: string }): Promise<{ theme: WmtTheme; manifest: WmtTheme["manifest"]; tokens: WmtTheme["tokens"]; hasCore: boolean; hasApp: boolean; roles: string[]; coverage: Coverage; background: { name: string; mime: string } | null }>;
  remove(slot?: string): boolean;
  current(slot?: string): string;
}

export declare const Whisper: WhisperApi;
export declare const WMT: WMTApi;
export declare const WhisperThemeCss: ThemeCssApi;
export declare const WhisperEmbed: EmbedApi;
export default Whisper;

declare global {
  interface Window { Whisper: WhisperApi; WMT: WMTApi; WhisperThemeCss: ThemeCssApi; WhisperEmbed: EmbedApi }
}
