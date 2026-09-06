/**
 * How a running turn names the person's surface.
 *
 * The mount that started a turn puts this header on the exchange, and
 * {@link surface} reads it back. It is an ordinary exchange header rather
 * than ambient state so it survives every derived exchange the pipeline
 * makes, is visible in a trace, and cannot be read by a route running on a
 * turn that never had one.
 */

/**
 * Exchange header naming the live surface a turn is running for.
 *
 * Exported as a constant per the magic-strings rule in the definition of
 * done: a route or a test that needs to build or assert on one gets
 * autocomplete rather than a string to copy.
 */
export const AGENT_SURFACE_HEADER = "routecraft.agent.surface";

/**
 * Which kind of thing is on the other end of a surface.
 *
 * One value today. It is a discriminant rather than an assumption because
 * the second backend is expected: a chat surface reached the same way, with
 * the same `surface()` call in a route and a different transport under it.
 */
export type AgentSurfaceKind = "acp";

/** What the header carries: enough to find the live connection again. */
export interface AgentSurfaceRef {
  readonly kind: AgentSurfaceKind;
  /** The protocol session this turn belongs to. */
  readonly session: string;
  /** Resolves the live connection in the registry. */
  readonly connection: string;
}

/**
 * Read the surface reference off an exchange's headers, or `undefined`
 * when the turn has none.
 *
 * Shape-checked rather than cast: headers are a writable bag, so a step
 * can put anything under this key, and a route reading a mangled value as
 * a reference would fail somewhere less useful than here.
 *
 * @internal
 */
export function surfaceRefOf(headers: {
  readonly [key: string]: unknown;
}): AgentSurfaceRef | undefined {
  const value = headers[AGENT_SURFACE_HEADER];
  if (value === null || typeof value !== "object") return undefined;
  const ref = value as Partial<AgentSurfaceRef>;
  return ref.kind === "acp" &&
    typeof ref.session === "string" &&
    typeof ref.connection === "string"
    ? (ref as AgentSurfaceRef)
    : undefined;
}
