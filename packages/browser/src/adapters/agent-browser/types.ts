import type { Exchange } from "@routecraft/routecraft";

/** Option value that can be static or resolved from the exchange. */
export type Resolvable<T, V> = V | ((exchange: Exchange<T>) => V);

/** Shared options available on every command. */
export interface AgentBrowserBaseOptions<T = unknown> {
  /** Override auto-session derived from exchange.id */
  session?: Resolvable<T, string>;
  /** Run browser in headed mode (show window). */
  headed?: boolean;
  /** Request JSON output and parse into result.parsed. */
  json?: boolean;
  /** Escape hatch: extra CLI flags (ignored in library mode). */
  args?: string[];
}

/** Command-specific options for autocomplete. */
export interface AgentBrowserCommandMap<T = unknown> {
  open: { url: Resolvable<T, string> };
  click: { selector: Resolvable<T, string>; newTab?: boolean };
  dblclick: { selector: Resolvable<T, string> };
  fill: {
    selector: Resolvable<T, string>;
    value: Resolvable<T, string>;
  };
  type: {
    selector: Resolvable<T, string>;
    value: Resolvable<T, string>;
  };
  press: { key: string };
  hover: { selector: Resolvable<T, string> };
  focus: { selector: Resolvable<T, string> };
  select: { selector: Resolvable<T, string>; value: string };
  check: { selector: Resolvable<T, string> };
  uncheck: { selector: Resolvable<T, string> };
  scroll: {
    direction: "up" | "down" | "left" | "right";
    pixels?: number;
  };
  snapshot: { interactive?: boolean };
  screenshot: { path?: string; full?: boolean; annotate?: boolean };
  eval: { js: Resolvable<T, string> };
  get: {
    info:
      | "text"
      | "html"
      | "value"
      | "title"
      | "url"
      | "count"
      | "attr"
      | "box"
      | "styles";
    selector?: Resolvable<T, string>;
    attr?: string;
  };
  wait: {
    selector?: Resolvable<T, string>;
    ms?: number;
  };
  close: Record<string, never>;
  back: Record<string, never>;
  forward: Record<string, never>;
  reload: Record<string, never>;
  tab: {
    action?: "new" | "close" | "list";
    index?: number;
    url?: string;
  };
}

export type AgentBrowserCommand = keyof AgentBrowserCommandMap;

export interface AgentBrowserResult {
  stdout: string;
  parsed?: unknown;
  exitCode: number;
}

/** @internal Merged command options + base for a given command. */
export type AgentBrowserOptionsMerged<
  T,
  C extends AgentBrowserCommand,
> = AgentBrowserCommandMap<T>[C] & AgentBrowserBaseOptions<T>;
