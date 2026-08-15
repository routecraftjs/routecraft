import type { StandardSchemaV1 } from "@standard-schema/spec";
import { formatSchemaIssues, rcError } from "@routecraft/routecraft";
import { exposedNameFor, parseProxyRef } from "./proxy.ts";
import { MCP_TOOL_NAME_PATTERN } from "./types.ts";
import type { McpPluginOptions } from "./types.ts";
import {
  isSplittableNameHead,
  TOOL_NAME_PATTERN_SOURCE,
  TOOL_NAME_SEPARATOR,
} from "../tool-name.ts";

/** Standard Schema validate result: success has value, failure has issues. */
type ValidateResult<T = unknown> =
  { value: T; issues?: never } | { value?: never; issues: readonly unknown[] };

/**
 * Validates MCP plugin options at apply time.
 * For full schema validation (required props, shape), use validateWithSchema() with a
 * StandardSchemaV1 from Zod, Valibot, or ArkType before calling mcpPlugin().
 * @internal
 */
/** RFC 6749 §3.3 scope-token: visible ASCII except space, `"` and `\`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

export function validateMcpPluginOptions(options: McpPluginOptions): void {
  if (options.transport === "http") {
    if (
      options.port !== undefined &&
      (!Number.isInteger(options.port) ||
        options.port < 0 ||
        options.port > 65535)
    ) {
      throw new TypeError("mcpPlugin: port must be a 0-65535 integer");
    }
    if (options.server !== undefined && options.server.length === 0) {
      throw new TypeError("mcpPlugin: server name must not be empty");
    }
    if (options.path !== undefined && !options.path.startsWith("/")) {
      throw new TypeError("mcpPlugin: path must start with '/'");
    }
  }

  // Note: `cors` is silently ignored when transport is not 'http', matching
  // the `auth` posture. The stdio startup path simply does not read it.
  // The shape of `cors.origin` is validated here so misconfiguration fails at
  // plugin-apply time alongside `auth`, `port`, and `host`; `resolveCorsOptions`
  // keeps the same throw as defence-in-depth for callers who bypass this gate.
  if (
    options.transport === "http" &&
    options.cors !== undefined &&
    options.cors !== false
  ) {
    const { origin } = options.cors;
    const ok =
      origin === "*" ||
      typeof origin === "string" ||
      Array.isArray(origin) ||
      typeof origin === "function";
    if (!ok) {
      throw new TypeError(
        "mcpPlugin: cors.origin must be '*', a string, a string array, or a function",
      );
    }
  }

  // Validate auth options
  if (options.auth !== undefined) {
    const auth = options.auth as unknown as Record<string, unknown>;

    // The pre-2026 authorization-server-proxy shape. It has no `validator`, so
    // it would otherwise start cleanly and then refuse every request with 401.
    // Fail at construction with the migration instead.
    if (
      "provider" in auth ||
      "endpoints" in auth ||
      "verifyAccessToken" in auth ||
      "getClient" in auth
    ) {
      throw new TypeError(
        "mcpPlugin: auth uses the removed OAuth authorization-server proxy shape " +
          "({ provider, endpoints, verifyAccessToken, getClient }). The MCP server is " +
          "now a resource server: use oauth({ verify, issuer, requiredScopes }) and " +
          "point clients at your IdP's own authorization and token endpoints, which " +
          "they discover from the protected-resource metadata.",
      );
    }

    if ("validator" in auth) {
      if (typeof auth["validator"] !== "function") {
        throw new TypeError(
          "mcpPlugin: auth.validator must be a function that returns a Principal (throw to reject)",
        );
      }
    } else {
      throw new TypeError(
        "mcpPlugin: auth must have a 'validator' function. " +
          "Use jwt(), jwks(), oauth(), or a custom { validator } object.",
      );
    }

    // Required scopes are reflected into a `WWW-Authenticate` challenge, whose
    // grammar (RFC 6749 §3.3) excludes quotes, backslashes and spaces. Reject
    // them here so a misconfiguration surfaces at startup rather than as a
    // corrupted header on the first refusal.
    const requiredScopes = auth["requiredScopes"];
    if (requiredScopes !== undefined) {
      if (!Array.isArray(requiredScopes)) {
        throw new TypeError(
          "mcpPlugin: auth.requiredScopes must be an array of scope strings",
        );
      }
      for (const scope of requiredScopes as unknown[]) {
        if (typeof scope !== "string" || !SCOPE_TOKEN.test(scope)) {
          throw new TypeError(
            `mcpPlugin: auth.requiredScopes contains an invalid scope ${JSON.stringify(scope)}. ` +
              "A scope token is one or more visible ASCII characters excluding space, " +
              "double quote and backslash (RFC 6749 §3.3).",
          );
        }
      }
    }

    // The expiry gate fails closed on a non-finite tolerance, so a NaN or
    // negative value would refuse every request at runtime. Say so at startup.
    const clockToleranceSec = auth["clockToleranceSec"];
    if (
      clockToleranceSec !== undefined &&
      (typeof clockToleranceSec !== "number" ||
        !Number.isFinite(clockToleranceSec) ||
        clockToleranceSec < 0)
    ) {
      throw new TypeError(
        "mcpPlugin: auth.clockToleranceSec must be a finite, non-negative number of seconds",
      );
    }
  }

  // Validate stdio client configs
  if (options.clients) {
    for (const [name, config] of Object.entries(options.clients)) {
      // A client name is one segment of the `mcp__<server>__<tool>` wire
      // name an agent sees, and resolution splits that at the FIRST
      // separator after the prefix. A client called `a__b` exposing `c`
      // therefore generates `mcp__a__b__c`, which reads back as server
      // `a`, tool `b__c`: a valid-looking name pointing at nothing, and
      // two distinct pairs could collapse onto one name.
      //
      // Rejected here rather than only at resolution because this is
      // the half we own. Client names are chosen locally in this very
      // option; tool names come from the remote. Resolution still drops
      // such tools with a warning for a registry populated directly,
      // but reaching that path through `mcpPlugin` meant every tool on
      // the client vanished at dispatch with nothing failing at
      // startup. Constraining the server alone is enough to make the
      // grammar unambiguous, so a remote may keep using `__` in its own
      // tool names freely.
      //
      // The exact shapes that break the split, and why a trailing
      // underscore is one of them, live with the separator in
      // `isSplittableNameHead`. Both this throw and the resolution-time
      // drop in `agent/tools/selection.ts` call it, so the two layers
      // cannot disagree about what they reject.
      if (!isSplittableNameHead(name)) {
        // Collapse runs and trim the edges, so the name offered back is
        // one the check above actually accepts. Naively splitting on
        // the separator does not: `a____b` would yield `a__b` and `a__`
        // would yield `a_`, both rejected again by the very error that
        // suggested them. A name with nothing left after trimming
        // (`""`, `"___"`) still gets a concrete placeholder, so every
        // rejection carries something copyable.
        const salvaged = name.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
        const suggested = salvaged === "" ? "client" : salvaged;
        throw rcError("RC5003", undefined, {
          message: `mcpPlugin: client name "${name}" must not be empty, contain "${TOOL_NAME_SEPARATOR}", or end with "_". It becomes the server segment of the generated "mcp__<server>__<tool>" tool name, which is split at the first "${TOOL_NAME_SEPARATOR}" after the prefix, so any of those makes the name ambiguous or collides with another client.`,
          suggestion: `Rename the client to something without "${TOOL_NAME_SEPARATOR}" (a single underscore inside the name is fine, e.g. "${suggested}").`,
        });
      }
      if (
        typeof config === "object" &&
        config !== null &&
        "transport" in config &&
        config.transport === "stdio"
      ) {
        if (!config.command || typeof config.command !== "string") {
          throw new TypeError(
            `mcpPlugin: stdio client "${name}" must have a non-empty command string`,
          );
        }
      }
    }
  }

  // Validate proxy selection. Refs must parse, reference a registered client,
  // and produce statically unique exposed names; wildcard refs cannot carry
  // name/description overrides (they fan out to many tools).
  if (options.proxy !== undefined) {
    if (!Array.isArray(options.proxy)) {
      throw new TypeError(
        "mcpPlugin: proxy must be an array of ref strings or { ref, ... } configs",
      );
    }
    const seenRefs = new Set<string>();
    const seenNames = new Set<string>();
    for (const raw of options.proxy) {
      const isString = typeof raw === "string";
      const isObject =
        typeof raw === "object" && raw !== null && !Array.isArray(raw);
      if (!isString && !isObject) {
        throw new TypeError(
          "mcpPlugin: each proxy entry must be a ref string or a { ref, ... } config object",
        );
      }
      const entry = isString ? { ref: raw } : raw;
      const { serverId, toolName } = parseProxyRef(entry.ref);
      // Own-property check: `serverId in options.clients` would accept
      // inherited keys (constructor, toString, ...) that client setup, which
      // iterates `Object.entries`, never registers, leaving the ref
      // permanently unresolved at runtime.
      if (!options.clients || !Object.hasOwn(options.clients, serverId)) {
        throw new TypeError(
          `mcpPlugin: proxy ref "${entry.ref}" references unknown client "${serverId}". Register it under clients.`,
        );
      }
      const isWildcard = toolName === "*";
      if (
        isWildcard &&
        (entry.name !== undefined || entry.description !== undefined)
      ) {
        throw new TypeError(
          `mcpPlugin: proxy ref "${entry.ref}" is a wildcard and cannot set name or description overrides`,
        );
      }
      // Guard the type at runtime too: RegExp.test coerces a non-string
      // (e.g. a number from untyped JS) to a string, which would pass the
      // pattern and then surface as a non-string tool name on tools/list.
      if (
        entry.name !== undefined &&
        (typeof entry.name !== "string" ||
          !MCP_TOOL_NAME_PATTERN.test(entry.name))
      ) {
        throw new TypeError(
          `mcpPlugin: proxy name override "${String(entry.name)}" must be a string matching ${TOOL_NAME_PATTERN_SOURCE}`,
        );
      }
      if (entry.guard !== undefined && typeof entry.guard !== "function") {
        throw new TypeError(
          `mcpPlugin: proxy guard for "${entry.ref}" must be a function (throw inside it to reject a call)`,
        );
      }
      const refKey = `${serverId}:${toolName}`;
      if (seenRefs.has(refKey)) {
        throw new TypeError(
          `mcpPlugin: duplicate proxy ref "${entry.ref}" (resolves to "${refKey}")`,
        );
      }
      seenRefs.add(refKey);
      if (!isWildcard) {
        const exposed = exposedNameFor(entry, toolName);
        if (seenNames.has(exposed)) {
          throw new TypeError(
            `mcpPlugin: proxy entries expose the tool name "${exposed}" more than once. Use name overrides to disambiguate.`,
          );
        }
        seenNames.add(exposed);
      }
    }
  }

  // Validate restart options
  if (options.maxRestarts !== undefined) {
    if (
      typeof options.maxRestarts !== "number" ||
      !Number.isInteger(options.maxRestarts) ||
      options.maxRestarts < 0
    ) {
      throw new TypeError(
        "mcpPlugin: maxRestarts must be a non-negative integer",
      );
    }
  }
  if (options.restartDelayMs !== undefined) {
    if (
      typeof options.restartDelayMs !== "number" ||
      options.restartDelayMs <= 0
    ) {
      throw new TypeError(
        "mcpPlugin: restartDelayMs must be a positive number",
      );
    }
  }
  if (options.restartBackoffMultiplier !== undefined) {
    if (
      typeof options.restartBackoffMultiplier !== "number" ||
      options.restartBackoffMultiplier < 1
    ) {
      throw new TypeError("mcpPlugin: restartBackoffMultiplier must be >= 1");
    }
  }

  // Validate HTTP tool refresh interval
  if (options.toolRefreshIntervalMs !== undefined) {
    if (
      typeof options.toolRefreshIntervalMs !== "number" ||
      !Number.isInteger(options.toolRefreshIntervalMs) ||
      options.toolRefreshIntervalMs < 0
    ) {
      throw new TypeError(
        "mcpPlugin: toolRefreshIntervalMs must be a non-negative integer",
      );
    }
  }
}

/**
 * Validate plugin options with a StandardSchemaV1 (e.g. from Zod, Valibot, ArkType).
 * Use this when you need required props or full shape validation before mcpPlugin().
 *
 * @example
 * import { z } from "zod";
 * const schema = z.object({ transport: z.enum(["stdio", "http"]), port: z.number().optional() });
 * const validated = await validateWithSchema(options, schema);
 * mcpPlugin(validated);
 */
export async function validateWithSchema(
  options: McpPluginOptions,
  schema: StandardSchemaV1,
): Promise<McpPluginOptions> {
  const standard = (
    schema as {
      "~standard"?: {
        validate: (
          v: unknown,
        ) => ValidateResult<unknown> | Promise<ValidateResult<unknown>>;
      };
    }
  )["~standard"];
  if (!standard?.validate) {
    throw new Error(
      "mcpPlugin: schema must be a StandardSchemaV1 with ~standard.validate",
    );
  }
  let result = standard.validate(options);
  if (result instanceof Promise) {
    result = await result;
  }
  if (result.issues) {
    throw new Error(
      `mcpPlugin options validation failed: ${formatSchemaIssues(result.issues)}`,
    );
  }
  // Guard against schemas that pass (no issues) but omit value
  if (result.value === undefined) {
    throw new Error("mcpPlugin options validation failed: no value returned");
  }
  return result.value as McpPluginOptions;
}
