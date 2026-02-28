import { type Destination } from "../operations/to.ts";
import { type Exchange } from "../exchange.ts";

// agent-browser library API (internal package paths – see agent-browser docs)
import { BrowserManager } from "agent-browser/dist/browser.js";
import { executeCommand } from "agent-browser/dist/actions.js";

/** Option value that can be static or resolved from the exchange. */
export type Resolvable<T, V> = V | ((exchange: Exchange<T>) => V);

/** Shared options available on every command. */
export interface BrowserBaseOptions<T = unknown> {
  /** Override auto-session derived from exchange.id */
  session?: Resolvable<T, string>;
  /** Run browser in headed mode (show window). */
  headed?: boolean;
  /** Timeout in milliseconds. */
  timeout?: number;
  /** Request JSON output and parse into result.parsed. */
  json?: boolean;
  /** Escape hatch: extra CLI flags (ignored in library mode). */
  args?: string[];
}

/** Command-specific options for autocomplete. */
export interface BrowserCommandMap<T = unknown> {
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
    text?: string;
    url?: string;
    load?: string;
    fn?: string;
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

export type BrowserCommand = keyof BrowserCommandMap;

export interface BrowserResult {
  stdout: string;
  parsed?: unknown;
  exitCode: number;
}

/** Sanitize exchange id to agent-browser session name: alphanumeric, hyphen, underscore only. */
export function sanitizeSessionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

type ResolvedCommandOptions = Record<string, unknown>;

function resolve<T, V>(
  val: Resolvable<T, V> | undefined,
  exchange: Exchange<T>,
): V | undefined {
  if (val === undefined) return undefined;
  if (typeof val === "function")
    return (val as (e: Exchange<T>) => V)(exchange);
  return val as V;
}

function requireOpt(
  opts: ResolvedCommandOptions,
  key: string,
  label: string,
): string {
  const v = opts[key];
  if (v === undefined || v === null)
    throw new Error(`Browser adapter: required option "${label}" was missing`);
  return String(v);
}

/** Agent-browser protocol command shape (internal API). */
interface AgentBrowserCommand {
  id: string;
  action: string;
  [key: string]: unknown;
}

/** Session store: one BrowserManager per session id for split/aggregate isolation. */
const sessionManagers = new Map<string, BrowserManager>();

/**
 * Build agent-browser library command object from our (command, opts).
 */
function buildLibraryCommand(
  id: string,
  command: BrowserCommand,
  opts: ResolvedCommandOptions,
): AgentBrowserCommand[] {
  const cmds: AgentBrowserCommand[] = [];
  const base = { id };

  switch (command) {
    case "open": {
      const url = requireOpt(opts, "url", "open");
      cmds.push({ ...base, action: "navigate", url });
      break;
    }
    case "click":
      cmds.push({
        ...base,
        action: "click",
        selector: requireOpt(opts, "selector", "click"),
        newTab: opts["newTab"] ?? false,
      });
      break;
    case "dblclick":
      cmds.push({
        ...base,
        action: "dblclick",
        selector: requireOpt(opts, "selector", "dblclick"),
      });
      break;
    case "fill":
      cmds.push({
        ...base,
        action: "fill",
        selector: requireOpt(opts, "selector", "fill"),
        value: requireOpt(opts, "value", "fill"),
      });
      break;
    case "type":
      cmds.push({
        ...base,
        action: "type",
        selector: requireOpt(opts, "selector", "type"),
        text: requireOpt(opts, "value", "type"),
      });
      break;
    case "press":
      cmds.push({
        ...base,
        action: "press",
        key: requireOpt(opts, "key", "press"),
      });
      break;
    case "hover":
      cmds.push({
        ...base,
        action: "hover",
        selector: requireOpt(opts, "selector", "hover"),
      });
      break;
    case "focus":
      cmds.push({
        ...base,
        action: "focus",
        selector: requireOpt(opts, "selector", "focus"),
      });
      break;
    case "select":
      cmds.push({
        ...base,
        action: "select",
        selector: requireOpt(opts, "selector", "select"),
        values: requireOpt(opts, "value", "select"),
      });
      break;
    case "check":
      cmds.push({
        ...base,
        action: "check",
        selector: requireOpt(opts, "selector", "check"),
      });
      break;
    case "uncheck":
      cmds.push({
        ...base,
        action: "uncheck",
        selector: requireOpt(opts, "selector", "uncheck"),
      });
      break;
    case "scroll":
      cmds.push({
        ...base,
        action: "scroll",
        direction: requireOpt(opts, "direction", "scroll"),
        amount: opts["pixels"] ?? 100,
      });
      break;
    case "snapshot":
      cmds.push({
        ...base,
        action: "snapshot",
        interactive: opts["interactive"] ?? false,
      });
      break;
    case "screenshot":
      cmds.push({
        ...base,
        action: "screenshot",
        path: opts["path"] ?? null,
        fullPage: opts["full"] ?? false,
        annotate: opts["annotate"] ?? false,
      });
      break;
    case "eval":
      cmds.push({
        ...base,
        action: "evaluate",
        script: requireOpt(opts, "js", "eval"),
      });
      break;
    case "get": {
      const info = requireOpt(opts, "info", "get");
      const actionMap: Record<string, string> = {
        text: "gettext",
        html: "innerhtml",
        value: "inputvalue",
        title: "title",
        url: "url",
        count: "count",
        attr: "getattribute",
        box: "boundingbox",
        styles: "styles",
      };
      const action = actionMap[info];
      if (info === "title" || info === "url") {
        cmds.push({ ...base, action });
      } else if (info === "attr") {
        cmds.push({
          ...base,
          action: "getattribute",
          selector: requireOpt(opts, "selector", "get.selector"),
          attribute: requireOpt(opts, "attr", "get.attr"),
        });
      } else {
        cmds.push({
          ...base,
          action,
          selector: requireOpt(opts, "selector", `get.${info}`),
        });
      }
      break;
    }
    case "wait":
      cmds.push({
        ...base,
        action: "wait",
        selector:
          opts["selector"] != null ? String(opts["selector"]) : undefined,
        timeout: opts["ms"] != null ? Number(opts["ms"]) : undefined,
      });
      break;
    case "close":
      cmds.push({ ...base, action: "close" });
      break;
    case "back":
      cmds.push({ ...base, action: "back" });
      break;
    case "forward":
      cmds.push({ ...base, action: "forward" });
      break;
    case "reload":
      cmds.push({ ...base, action: "reload" });
      break;
    case "tab": {
      const action = opts["action"];
      if (action === "list") cmds.push({ ...base, action: "tab_list" });
      else if (action === "new")
        cmds.push({
          ...base,
          action: "tab_new",
          url: opts["url"] != null ? String(opts["url"]) : undefined,
        });
      else if (action === "close")
        cmds.push({
          ...base,
          action: "tab_close",
          index: opts["index"] != null ? Number(opts["index"]) : 0,
        });
      else if (opts["index"] != null)
        cmds.push({
          ...base,
          action: "tab_switch",
          index: Number(opts["index"]),
        });
      else cmds.push({ ...base, action: "tab_list" });
      break;
    }
    default:
      break;
  }
  return cmds;
}

/** Get or create BrowserManager for session; launch if needed. */
async function getOrCreateManager(
  sessionId: string,
  headed: boolean,
): Promise<BrowserManager> {
  let manager = sessionManagers.get(sessionId);
  if (!manager) {
    manager = new BrowserManager();
    await executeCommand(
      {
        id: sessionId,
        action: "launch",
        headless: !headed,
      } as Parameters<typeof executeCommand>[0],
      manager,
    );
    sessionManagers.set(sessionId, manager);
  }
  return manager;
}

/** Map agent-browser response data to stdout string for BrowserResult. */
function dataToStdout(data: Record<string, unknown>): string {
  if (data["snapshot"] != null) return String(data["snapshot"]);
  if (data["text"] != null) return String(data["text"]);
  if (data["html"] != null) return String(data["html"]);
  if (data["value"] != null) return String(data["value"]);
  if (data["title"] != null) return String(data["title"]);
  if (data["url"] != null) return String(data["url"]);
  if (data["result"] !== undefined) return JSON.stringify(data["result"]);
  if (data["count"] != null) return String(data["count"]);
  if (data["attribute"] != null && data["value"] != null)
    return String(data["value"]);
  if (data["box"] != null) return JSON.stringify(data["box"]);
  if (data["tabs"] != null) return JSON.stringify(data["tabs"]);
  return JSON.stringify(data);
}

/** Internal: merged command options + base for a given command. */
type BrowserOptionsMerged<
  T,
  C extends BrowserCommand,
> = BrowserCommandMap<T>[C] & BrowserBaseOptions<T>;

export class BrowserAdapter<
  T = unknown,
  C extends BrowserCommand = BrowserCommand,
> implements Destination<T, BrowserResult> {
  readonly adapterId = "routecraft.adapter.browser";

  constructor(
    private readonly command: C,
    private readonly options: BrowserOptionsMerged<
      T,
      C
    > = {} as BrowserOptionsMerged<T, C>,
  ) {}

  async send(exchange: Exchange<T>): Promise<BrowserResult> {
    const session =
      resolve(this.options.session, exchange) ?? sanitizeSessionId(exchange.id);
    const headed = this.options.headed ?? false;

    const resolved: ResolvedCommandOptions = {};
    const raw = this.options as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (
        key === "session" ||
        key === "headed" ||
        key === "timeout" ||
        key === "json" ||
        key === "args"
      )
        continue;
      const v = raw[key];
      if (typeof v === "function")
        (resolved as Record<string, unknown>)[key] = (
          v as (e: Exchange<T>) => unknown
        )(exchange);
      else resolved[key] = v;
    }

    const cmds = buildLibraryCommand(exchange.id, this.command, resolved);
    if (cmds.length === 0) {
      return { stdout: "", exitCode: 0 };
    }

    const manager = await getOrCreateManager(session, headed);

    try {
      let lastData: Record<string, unknown> = {};
      for (const cmd of cmds) {
        const response = await executeCommand(
          cmd as Parameters<typeof executeCommand>[0],
          manager,
        );
        const res = response as {
          success: boolean;
          data?: Record<string, unknown>;
          error?: string;
        };
        if (!res.success) {
          return {
            stdout: res.error ?? "Unknown error",
            exitCode: 1,
          };
        }
        if (res.data) lastData = res.data;
      }

      if (this.command === "close" && typeof manager.close === "function") {
        await manager.close().catch(() => {});
      }
      const stdout = dataToStdout(lastData);
      const result: BrowserResult = { stdout, exitCode: 0 };
      if (this.options.json) {
        result.parsed = lastData;
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { stdout: message, exitCode: 1 };
    } finally {
      if (this.command === "close") {
        sessionManagers.delete(session);
      }
    }
  }
}

/**
 * Creates a browser destination adapter using the agent-browser library.
 * Session is derived from exchange.id so split/aggregate get isolated sessions.
 * Use with `.to()`, `.enrich()`, or `.tap()`. Requires `agent-browser` as a dependency.
 *
 * @param command - Agent-browser command (e.g. `open`, `click`, `snapshot`, `get`)
 * @param options - Command-specific options plus base options (session, headed, timeout, json)
 * @returns A Destination that runs the command and returns `{ stdout, parsed?, exitCode }`
 *
 * @example
 * ```typescript
 * .to(browser('open', { url: (ex) => ex.body.url }))
 * .tap(browser('snapshot', { json: true }))
 * .enrich(browser('get', { info: 'text', selector: 'h1' }), only((r) => r.stdout, 'title'))
 * ```
 */
export function browser<T = unknown, C extends BrowserCommand = BrowserCommand>(
  command: C,
  options?: BrowserCommandMap<T>[C] & BrowserBaseOptions<T>,
): Destination<T, BrowserResult> {
  return new BrowserAdapter<T, C>(
    command,
    (options ?? {}) as BrowserOptionsMerged<T, C>,
  );
}
