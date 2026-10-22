import {
  HeadersKeys,
  standardSchemaFromJsonSchema,
  type CraftContext,
} from "@routecraft/routecraft";
import { isMcpAdapter } from "../brand.ts";
import { mergeAnnotations } from "./annotation-tags.ts";
import type { McpService } from "./port.ts";
import {
  MCP_TOOL_NAME_PATTERN,
  McpHeadersKeys,
  type McpLocalToolEntry,
  type McpProxyRegistration,
  type McpToolRegistryEntry,
} from "./types.ts";

/** A parsed `mcp({ proxy })` ref. `tool` is `"*"` for a whole client. */
export interface McpProxyRef {
  serverId: string;
  tool: string;
}

/**
 * Parse a proxy ref: `"server:tool"`, `"server:*"`, or bare `"server"`
 * (the same as `"server:*"`). Colons beyond the first stay in the tool
 * segment, as in the agent's `MCP(server:ns:tool)` grammar.
 *
 * @throws TypeError on a malformed ref, so option validation and the
 *   source's subscribe fail with one message
 * @internal
 */
export function parseProxyRef(ref: string): McpProxyRef {
  if (typeof ref !== "string" || ref.trim() === "") {
    throw new TypeError(
      'mcp({ proxy }): proxy must be a non-empty string like "server:tool", "server:*", or "server"',
    );
  }
  const idx = ref.indexOf(":");
  if (idx === -1) return { serverId: ref, tool: "*" };
  const serverId = ref.slice(0, idx);
  const tool = ref.slice(idx + 1);
  if (serverId === "" || tool === "") {
    throw new TypeError(
      `mcp({ proxy }): proxy "${ref}" is malformed. Use "server:tool", "server:*", or "server".`,
    );
  }
  return { serverId, tool };
}

/**
 * The key a registration is held under: one exact or one star per client
 * and tool. Encoded as a JSON pair so a tool name carrying a colon cannot
 * read as a different client and tool.
 */
export function proxyRegistrationKey(serverId: string, tool: string): string {
  return JSON.stringify([serverId, tool]);
}

/**
 * The registration that covers a remote tool: the exact one when there is
 * one, otherwise the client's star registration, otherwise undefined.
 *
 * @internal
 */
export function coveringProxy(
  service: McpService,
  serverId: string,
  tool: string,
): McpProxyRegistration | undefined {
  return (
    service.proxies.get(proxyRegistrationKey(serverId, tool)) ??
    service.proxies.get(proxyRegistrationKey(serverId, "*"))
  );
}

/**
 * The route whose source declares a proxy over `serverId:tool`, live or
 * not: an exact declaration first, else a star over the client. A live
 * registration is what {@link coveringProxy} answers; this reads the route
 * definitions instead, so the agent tool resolver can tell a tool nobody
 * governs from one whose governing route is held back by `.enabled()`.
 * The second is withheld rather than offered raw: a disabled policy must
 * not open the door it was written to close.
 *
 * @internal
 */
export function declaredProxy(
  context: CraftContext,
  serverId: string,
  tool: string,
): { routeId: string; tool: string } | undefined {
  let star: { routeId: string; tool: string } | undefined;
  for (const route of context.getRoutes()) {
    for (const source of route.definition.sources) {
      const ref = (source as { proxyRef?: McpProxyRef }).proxyRef;
      if (!isMcpAdapter(source) || ref === undefined) continue;
      if (ref.serverId !== serverId) continue;
      if (ref.tool === tool) return { routeId: route.definition.id, tool };
      if (ref.tool === "*") star ??= { routeId: route.definition.id, tool };
    }
  }
  return star;
}

/** A description with text in it, or nothing: an empty one earns the fallback. */
function nonEmpty(text: string | undefined): string | undefined {
  return text !== undefined && text.length > 0 ? text : undefined;
}

/** A tool a proxy registration exposes: a local entry plus where it goes. */
export interface McpProxiedEntry {
  entry: McpLocalToolEntry;
  registration: McpProxyRegistration;
  remote: McpToolRegistryEntry;
}

/**
 * The tools the proxy registrations expose right now, by exposed name,
 * resolved against the clients' live tool lists.
 *
 * Each is an ordinary {@link McpLocalToolEntry}: the remote's metadata
 * under the exposed name, the remote's JSON Schemas as pass-through
 * Standard Schemas (the remote validates at its door), and a handler that
 * runs the registered route with the remote tool's name, the client and
 * the annotations on the headers. The server lists and calls it exactly
 * as it lists and calls a `.from(mcp())` route's entry, so every rule that
 * applies to one applies to the other.
 *
 * A remote tool is not exposed, with a warning through `warn`, when its
 * exposed name does not conform to the tool name pattern or when two
 * registrations expose the same name (the first in registration order
 * wins). Which registration covers a tool follows {@link coveringProxy}.
 *
 * @internal
 */
export function resolveProxiedEntries(
  service: McpService,
  warn: (
    key: string,
    message: string,
    bindings: Record<string, unknown>,
  ) => void,
): Map<string, McpProxiedEntry> {
  const resolved = new Map<string, McpProxiedEntry>();
  for (const registration of service.proxies.values()) {
    const remotes =
      registration.tool === "*"
        ? service.tools
            .getToolsByServer(registration.serverId)
            .filter(
              (remote) =>
                coveringProxy(service, registration.serverId, remote.name) ===
                registration,
            )
        : [
            service.tools.getToolBySource(
              registration.serverId,
              registration.tool,
            ),
          ].filter(
            (remote): remote is McpToolRegistryEntry => remote !== undefined,
          );
    for (const remote of remotes) {
      const exposedName =
        registration.name ?? `${registration.prefix}${remote.name}`;
      if (!MCP_TOOL_NAME_PATTERN.test(exposedName)) {
        warn(
          `proxy:name:${exposedName}`,
          "mcp({ proxy }): a proxied tool's exposed name is not a valid MCP tool name; skipping it. Set a prefix or a name that matches the pattern.",
          {
            route: registration.routeId,
            server: registration.serverId,
            tool: remote.name,
            exposed: exposedName,
            pattern: String(MCP_TOOL_NAME_PATTERN),
          },
        );
        continue;
      }
      const existing = resolved.get(exposedName);
      if (existing) {
        warn(
          `proxy:collision:${exposedName}`,
          "mcp({ proxy }): two routes expose a proxied tool under one name; the first keeps it. Give one of them a prefix or a name.",
          {
            exposed: exposedName,
            route: existing.registration.routeId,
            server: existing.registration.serverId,
            tool: existing.remote.name,
            otherRoute: registration.routeId,
            otherServer: registration.serverId,
            otherTool: remote.name,
          },
        );
        continue;
      }
      resolved.set(exposedName, {
        entry: proxiedEntry(exposedName, registration, remote),
        registration,
        remote,
      });
    }
  }
  return resolved;
}

/**
 * The tools a client's proxy routes expose on that client's own mount,
 * keyed by the remote's names: every tool of the client that a registration
 * covers, exact over star. The root mount's prefixes and its collision
 * rules do not apply here, since the mount already names the client; a
 * remote name that is not a valid tool name is still skipped, with a
 * warning through `warn`.
 *
 * @internal
 */
export function resolveClientEntries(
  service: McpService,
  serverId: string,
  warn: (
    key: string,
    message: string,
    bindings: Record<string, unknown>,
  ) => void,
): Map<string, McpProxiedEntry> {
  const resolved = new Map<string, McpProxiedEntry>();
  for (const remote of service.tools.getToolsByServer(serverId)) {
    const registration = coveringProxy(service, serverId, remote.name);
    if (registration === undefined) continue;
    if (!MCP_TOOL_NAME_PATTERN.test(remote.name)) {
      warn(
        `proxy:remote-name:${serverId}:${remote.name}`,
        "mcp({ proxy }): a remote tool's name is not a valid MCP tool name; skipping it on the client's mount.",
        {
          route: registration.routeId,
          server: serverId,
          tool: remote.name,
          pattern: String(MCP_TOOL_NAME_PATTERN),
        },
      );
      continue;
    }
    resolved.set(remote.name, {
      entry: proxiedEntry(remote.name, registration, remote),
      registration,
      remote,
    });
  }
  return resolved;
}

/**
 * The local entry a registration exposes a remote tool as, under
 * `exposedName`. Shared with the agent tool resolver, which sends an
 * `MCP(server:tool)` reference through the covering route under the
 * reference's own name.
 *
 * @internal
 */
export function proxiedEntry(
  exposedName: string,
  registration: McpProxyRegistration,
  remote: McpToolRegistryEntry,
): McpLocalToolEntry {
  const entry: McpLocalToolEntry = {
    endpoint: exposedName,
    description:
      nonEmpty(registration.description) ??
      nonEmpty(remote.description) ??
      `Tool "${remote.name}" on client "${registration.serverId}".`,
    input: { body: standardSchemaFromJsonSchema(remote.inputSchema) },
    handler: (request) =>
      registration.handler({
        body: request.body,
        headers: {
          ...request.headers,
          [McpHeadersKeys.TOOL]: remote.name,
          [McpHeadersKeys.CLIENT]: registration.serverId,
          // Two tools under one star route share the route id and may share
          // arguments; the default cache key tells them apart by this.
          [HeadersKeys.CACHE_DISCRIMINATOR]: remote.name,
          ...(remote.annotations !== undefined
            ? { [McpHeadersKeys.ANNOTATIONS]: remote.annotations }
            : {}),
        },
      }),
  };
  const title = registration.title ?? remote.title;
  if (title !== undefined) entry.title = title;
  if (remote.outputSchema !== undefined) {
    entry.output = { body: standardSchemaFromJsonSchema(remote.outputSchema) };
  }
  const annotations = mergeAnnotations(
    remote.annotations,
    registration.annotations,
  );
  if (annotations !== undefined) entry.annotations = annotations;
  const icons = registration.icons ?? remote.icons;
  if (icons !== undefined) entry.icons = icons;
  if (registration.deferrable) entry.deferrable = true;
  return entry;
}
