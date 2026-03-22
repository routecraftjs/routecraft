import type { Exchange } from "@routecraft/routecraft";
import type { AgentBrowserCommand, Resolvable } from "./types.ts";

// agent-browser library API (internal package paths)
import { BrowserManager } from "agent-browser/dist/browser.js";
import { executeCommand } from "agent-browser/dist/actions.js";

/** Sanitize exchange id to agent-browser session name: alphanumeric, hyphen, underscore only. */
export function sanitizeSessionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

type ResolvedCommandOptions = Record<string, unknown>;

export function resolve<T, V>(
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
    throw new Error(
      `agentBrowser adapter: required option "${label}" was missing`,
    );
  return String(v);
}

/** Agent-browser protocol command shape (internal API). */
interface AgentBrowserProtocolCommand {
  id: string;
  action: string;
  [key: string]: unknown;
}

/** Session store: one BrowserManager per session id for split/aggregate isolation. */
const sessionManagers = new Map<string, BrowserManager>();

/**
 * Build agent-browser library command object from our (command, opts).
 */
export function buildLibraryCommand(
  id: string,
  command: AgentBrowserCommand,
  opts: ResolvedCommandOptions,
): AgentBrowserProtocolCommand[] {
  const cmds: AgentBrowserProtocolCommand[] = [];
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
export async function getOrCreateManager(
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

/** Map agent-browser response data to stdout string for AgentBrowserResult. */
export function dataToStdout(data: Record<string, unknown>): string {
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

/** Delete a session manager (called on close). */
export function deleteSessionManager(sessionId: string): void {
  sessionManagers.delete(sessionId);
}
