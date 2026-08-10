import {
  isDropped,
  rcError,
  validateAgainst,
  wasOutputValidated,
  type Exchange,
} from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { McpLocalToolEntry } from "./types.ts";
// Registers the AI error codes thrown here. Imported at the throw site rather
// than relying on the package index, so a caller reaching this module
// directly gets AI2001 / AI2002 instead of an unknown-code RC9901.
import "../errors.ts";

/**
 * The schema arms a conforming result may satisfy, and the single source of
 * what a tool's output contract is. `tools/list` advertises these arms and
 * {@link enforceAdvertisedOutput} accepts a body matching any of them, so the
 * promise and its enforcement cannot drift apart.
 *
 * One arm today. A route with a reachable durable `.suspend()` will advertise
 * `oneOf: [Output, Suspended]` (#550); adding that arm here teaches both sides
 * at once, and a suspension becomes a conforming result rather than a
 * violation.
 *
 * Empty when the route declares no `.output({ body })`: nothing is advertised,
 * so nothing is enforced.
 */
export function advertisedOutputArms(
  entry: McpLocalToolEntry,
): StandardSchemaV1[] {
  return entry.output?.body ? [entry.output.body] : [];
}

/**
 * Refuse to answer with a result the route never produced.
 *
 * A dropped exchange resolves with the body it came in with, so returning it
 * hands the caller its own request back as if the tool had answered.
 * `CraftClient.sendDirect` and the route-scope `forward` raise RC5031 on this;
 * MCP declines with AI2002, the same contract in the protocol's vocabulary.
 * Applies whether or not the tool declares an output: an echoed request is not
 * a result under any schema.
 *
 * @returns The decline error when the exchange was dropped, otherwise undefined
 */
export function declinedError(
  entry: McpLocalToolEntry,
  exchange: Exchange,
): Error | undefined {
  if (!isDropped(exchange)) return undefined;

  return rcError("AI2002", undefined, {
    message: `MCP tool "${entry.endpoint}" declined the request and produced no result`,
  });
}

/**
 * Enforce the tool's advertised output schema against the body about to be
 * published, throwing AI2001 when no advertised arm accepts it.
 *
 * A client is entitled to parse `structuredContent` against the schema
 * `tools/list` advertised, so publishing an unchecked body is a protocol
 * violation rather than a cosmetic mismatch.
 *
 * Skipped for a body the route already validated against the same schema.
 * Re-running it would not merely duplicate work: validation replaces the body
 * with the schema's output, and a transforming schema (`z.string().transform`,
 * `.pipe()`) rejects the value it just produced. What reaches the check is
 * therefore a result the pipeline never vouched for: a directly registered
 * tool entry, or a future suspension.
 */
export async function enforceAdvertisedOutput(
  entry: McpLocalToolEntry,
  exchange: Exchange,
): Promise<void> {
  const arms = advertisedOutputArms(entry);
  if (arms.length === 0 || wasOutputValidated(exchange)) return;

  const failures: string[] = [];
  for (const arm of arms) {
    const result = await validateAgainst(arm, exchange.body);
    if (result.ok) return;
    failures.push(result.message);
  }

  throw rcError("AI2001", new Error(failures.join("; ")), {
    message: `MCP tool "${entry.endpoint}" returned a body that does not match its declared output schema`,
  });
}
