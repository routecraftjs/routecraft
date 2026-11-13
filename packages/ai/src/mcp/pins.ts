import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { rcError, type Tag } from "@routecraft/routecraft";
import { isRecord } from "../shared/is-record.ts";
import type {
  McpIcon,
  McpPins,
  McpTool,
  McpToolAnnotations,
  McpToolClass,
} from "./types.ts";

/**
 * Tool definition pinning.
 *
 * A remote MCP server decides what its tools are called, what they say they
 * do and what arguments they take, and can change any of it between two
 * listings. Pinning holds a client to the definitions someone reviewed: the
 * lockfile records each approved definition and its hash, and a tool that is
 * new, or whose definition no longer matches, is served or withheld as the
 * client's `pins` say. Approval is a commit of the lockfile.
 *
 * This module is the rule alone: canonical form, hash, lockfile format and
 * the verdict for one listing. The registry applies it and the plugin reads
 * the file.
 */

/** The lockfile's name, in the directory the application starts in. */
export const MCP_LOCKFILE = "mcp.lock";

const TOOL_CLASSES: readonly McpToolClass[] = ["read", "write", "destructive"];

/** Every field of a tool a caller receives, and so every field a review covers. */
export interface McpPinnedDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  icons?: McpIcon[];
}

/** One approved tool in the lockfile. */
export interface McpLockedTool {
  class: McpToolClass;
  /** `sha256:` and the hex digest of the definition's canonical JSON. */
  hash: string;
  definition: McpPinnedDefinition;
}

/** The lockfile: the approved tools of each pinned client. */
export interface McpLockfile {
  version: 1;
  clients: Record<string, { tools: Record<string, McpLockedTool> }>;
}

/**
 * JSON with one spelling per value: keys sorted, and every character
 * outside printable ASCII written as a `\u` escape, so two definitions that
 * differ only in an invisible character differ visibly in a diff.
 * `indent` adds line breaks for the file; the hash uses none.
 *
 * The output is what every approved hash was taken over, so a change to
 * it invalidates every lockfile and needs a new lockfile version.
 *
 * @internal
 */
export function canonicalJson(value: unknown, indent = 0): string {
  const text = JSON.stringify(sorted(value), null, indent);
  return text.replace(
    /[^\x20-\x7e\n]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * A record with no prototype, for keys a remote server chose. Assigning
 * `__proto__` on an ordinary object sets its prototype instead of a key,
 * which would leave that part of a definition out of the hash and out of
 * the file a reviewer reads.
 *
 * @internal
 */
export function ownRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out = ownRecord<unknown>();
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) out[key] = sorted(record[key]);
  }
  return out;
}

/**
 * The part of a listed tool a caller receives.
 *
 * @internal
 */
export function pinnedDefinition(tool: McpTool): McpPinnedDefinition {
  const definition: McpPinnedDefinition = {
    name: tool.name,
    inputSchema: tool.inputSchema as Record<string, unknown>,
  };
  if (tool.title !== undefined) definition.title = tool.title;
  if (tool.description !== undefined) {
    definition.description = tool.description;
  }
  if (tool.outputSchema !== undefined) {
    definition.outputSchema = tool.outputSchema as Record<string, unknown>;
  }
  if (tool.annotations !== undefined) {
    definition.annotations = tool.annotations;
  }
  if (tool.icons !== undefined) definition.icons = tool.icons;
  return definition;
}

/**
 * The hash a definition is approved under.
 *
 * @internal
 */
export function definitionHash(definition: McpPinnedDefinition): string {
  return `sha256:${createHash("sha256").update(canonicalJson(definition)).digest("hex")}`;
}

/**
 * The class proposed for a tool nobody has classified yet, from the server's
 * own hints: read-only when it says so, a write when it says it is not
 * destructive, destructive otherwise. A proposal for the person approving
 * the lockfile to correct, never read again once the class is in the file.
 *
 * @internal
 */
export function proposedClass(
  annotations: McpToolAnnotations | undefined,
): McpToolClass {
  if (annotations?.readOnlyHint === true) return "read";
  if (annotations?.destructiveHint === false) return "write";
  return "destructive";
}

/**
 * The route tags a class stands for, so a selector or a guard that reads
 * tags reads the approved class and not the server's hints.
 *
 * @internal
 */
export function tagsOfClass(toolClass: McpToolClass): Tag[] {
  if (toolClass === "read") return ["read-only"];
  if (toolClass === "destructive") return ["destructive"];
  return [];
}

/**
 * Parse a lockfile, refusing anything this build cannot vouch for.
 *
 * Each hash is checked against the definition beside it. The definition is
 * what a reviewer reads and the hash is what a listing is held to, so a
 * file in which the two disagree would approve something nobody read.
 *
 * @throws RC5003 when the text is not a version 1 lockfile, or a tool's
 *   hash is not the hash of its definition
 * @internal
 */
export function parseLockfile(text: string, path: string): McpLockfile {
  const invalid = (why: string): Error =>
    rcError("RC5003", undefined, {
      message: `mcpPlugin: ${path} is not a lockfile this version reads: ${why}.`,
      suggestion:
        "Restore it from version control, or delete it and write it again with: craft mcp pin",
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid("it is not JSON");
  }
  if (!isRecord(parsed) || parsed["version"] !== 1) {
    throw invalid("its version is not 1");
  }
  if (!isRecord(parsed["clients"])) throw invalid("it has no clients");
  const clients: McpLockfile["clients"] = ownRecord();
  for (const [client, entry] of Object.entries(parsed["clients"])) {
    if (!isRecord(entry) || !isRecord(entry["tools"])) {
      throw invalid(`client "${client}" has no tools`);
    }
    const tools = ownRecord<McpLockedTool>();
    for (const [name, tool] of Object.entries(entry["tools"])) {
      if (
        !isRecord(tool) ||
        typeof tool["hash"] !== "string" ||
        !TOOL_CLASSES.includes(tool["class"] as McpToolClass) ||
        !isRecord(tool["definition"])
      ) {
        throw invalid(`tool "${client}:${name}" is malformed`);
      }
      const locked = tool as unknown as McpLockedTool;
      if (
        locked.definition.name !== name ||
        definitionHash(locked.definition) !== locked.hash
      ) {
        throw invalid(
          `the hash of tool "${client}:${name}" is not the hash of its definition`,
        );
      }
      tools[name] = locked;
    }
    clients[client] = { tools };
  }
  return { version: 1, clients };
}

/**
 * Where the lockfile is: `path` against the directory the application
 * starts in, `mcp.lock` there when none is given.
 *
 * @internal
 */
export function lockfilePath(path: string | undefined): string {
  return resolve(process.cwd(), path ?? MCP_LOCKFILE);
}

/**
 * Read the lockfile a pinned client is held to.
 *
 * @throws RC5003 when it is missing, unreadable or not a lockfile this
 *   version reads
 * @internal
 */
export async function readLockfile(
  path: string | undefined,
): Promise<McpLockfile> {
  const file = lockfilePath(path);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    throw rcError("RC5003", cause, {
      message: `mcpPlugin: a client sets pins and the lockfile ${file} cannot be read.`,
      suggestion:
        "Write it with: craft mcp pin. Commit it, and ship it beside the application.",
    });
  }
  return parseLockfile(text, file);
}

/**
 * The lockfile as it is written: clients and tools in name order, keys
 * sorted, so the same listing always produces the same bytes and a git diff
 * of the file is the review.
 *
 * @internal
 */
export function serializeLockfile(lockfile: McpLockfile): string {
  return `${canonicalJson(lockfile, 2)}\n`;
}

/**
 * The tools of one client as a fresh listing would lock them. A tool the
 * previous lockfile already classified keeps its class, whatever its
 * definition has become, because the class is the reviewer's and the
 * definition is the server's.
 *
 * @internal
 */
export function lockTools(
  listed: readonly McpTool[],
  previous: Record<string, McpLockedTool> | undefined,
): Record<string, McpLockedTool> {
  const tools = ownRecord<McpLockedTool>();
  for (const tool of listed) {
    const definition = pinnedDefinition(tool);
    tools[tool.name] = {
      class:
        (previous !== undefined && Object.hasOwn(previous, tool.name)
          ? previous[tool.name]?.class
          : undefined) ?? proposedClass(tool.annotations),
      hash: definitionHash(definition),
      definition,
    };
  }
  return tools;
}

/** A tool a listing carried that the client's pins keep back. */
export interface McpHeldTool {
  name: string;
  reason: "added" | "changed";
  /** The hash in the lockfile, absent for a tool it has never seen. */
  approved?: string;
  /** The hash of the definition the server lists now. */
  live: string;
}

/** What one listing of a pinned client comes to. */
export interface McpPinVerdict {
  /** The tools to serve, each with the class a policy may rely on. */
  served: Array<{
    tool: McpTool;
    definition: McpPinnedDefinition;
    class: McpToolClass;
  }>;
  held: McpHeldTool[];
  /** Locked tools served on a definition the lockfile does not vouch for. */
  changed: Array<{
    name: string;
    approved: string;
    live: string;
    warn: boolean;
  }>;
  /** Locked tools the server no longer lists. */
  removed: Array<{ name: string; approved: string }>;
}

/**
 * Judge one listing of a pinned client against its locked tools.
 *
 * A tool served on anything but its approved definition is classed
 * `destructive`: nobody has reviewed what it now says, so nothing may treat
 * it as safe. A name the server lists more than once is held when any of
 * its occurrences is.
 *
 * @internal
 */
export function judgeListing(
  pins: McpPins,
  locked: Record<string, McpLockedTool>,
  listed: readonly McpTool[],
): McpPinVerdict {
  const added = pins.added ?? "hold";
  const changed = pins.changed ?? "hold";
  const verdict: McpPinVerdict = {
    served: [],
    held: [],
    changed: [],
    removed: [],
  };
  const seen = new Set<string>();
  for (const tool of listed) {
    seen.add(tool.name);
    const definition = pinnedDefinition(tool);
    const live = definitionHash(definition);
    const approved = Object.hasOwn(locked, tool.name)
      ? locked[tool.name]
      : undefined;
    if (approved === undefined) {
      if (added === "hold") {
        verdict.held.push({ name: tool.name, reason: "added", live });
      } else {
        verdict.served.push({ tool, definition, class: "destructive" });
      }
      continue;
    }
    if (approved.hash === live) {
      verdict.served.push({ tool, definition, class: approved.class });
      continue;
    }
    if (changed === "hold") {
      verdict.held.push({
        name: tool.name,
        reason: "changed",
        approved: approved.hash,
        live,
      });
      continue;
    }
    verdict.served.push({ tool, definition, class: "destructive" });
    verdict.changed.push({
      name: tool.name,
      approved: approved.hash,
      live,
      warn: changed === "warn",
    });
  }
  for (const [name, tool] of Object.entries(locked)) {
    if (!seen.has(name)) verdict.removed.push({ name, approved: tool.hash });
  }
  // A name listed twice is one tool to a caller, so one held occurrence holds it.
  const held = new Set(verdict.held.map((each) => each.name));
  verdict.served = verdict.served.filter((each) => !held.has(each.tool.name));
  return verdict;
}

/**
 * A pinned tool leaving the state the lockfile approved: held back, served
 * on a definition nobody reviewed, or gone from the server.
 */
export type McpPinTransition =
  | ({ kind: "held"; serverId: string } & McpHeldTool)
  | {
      kind: "changed";
      serverId: string;
      name: string;
      approved: string;
      live: string;
      warn: boolean;
    }
  | { kind: "removed"; serverId: string; name: string; approved: string };

/** Why a pinned client's tool may not be called. */
export type McpPinRefusal =
  /** The client's tools have not been listed since start. */
  | "unlisted"
  /** The lockfile has never seen the tool. */
  | "added"
  /** The tool's definition is not the approved one. */
  | "changed"
  /** The client does not list the tool. */
  | "absent";

/**
 * What the tool registry asks of pinning: the rule for a client, and
 * somewhere to say a tool left its approved state. `mcpPlugin` supplies it
 * from the clients' `pins` and the lockfile.
 */
export interface McpPinRules {
  /** A client's pins and locked tools, or `undefined` when it is not pinned. */
  of(
    serverId: string,
  ): { pins: McpPins; locked: Record<string, McpLockedTool> } | undefined;
  /** Told once per transition, never once per listing. */
  report?(transition: McpPinTransition): void;
}
