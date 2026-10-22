import {
  HeadersKeys,
  standardSchemaFromJsonSchema,
} from "@routecraft/routecraft";
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

/** The key a registration is held under: one exact or one star per client and tool. */
export function proxyRegistrationKey(serverId: string, tool: string): string {
  return `${serverId}:${tool}`;
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
  warn: (key: string, message: string) => void,
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
          `mcp({ proxy }): route "${registration.routeId}" would expose "${registration.serverId}:${remote.name}" as "${exposedName}", which is not a valid MCP tool name; skipping it. Set a prefix or name that matches ${MCP_TOOL_NAME_PATTERN}.`,
        );
        continue;
      }
      const existing = resolved.get(exposedName);
      if (existing) {
        warn(
          `proxy:collision:${exposedName}`,
          `mcp({ proxy }): routes "${existing.registration.routeId}" and "${registration.routeId}" both expose "${exposedName}" (${existing.registration.serverId}:${existing.remote.name} and ${registration.serverId}:${remote.name}); the first keeps it. Give one of them a prefix or a name.`,
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
      registration.description ??
      remote.description ??
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
