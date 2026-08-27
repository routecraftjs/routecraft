/**
 * JSON for values that were never written to be JSON.
 *
 * Event payloads carry whatever the emitting code had to hand: an `Error`,
 * a live exchange, the route it is running on, the context that owns both.
 * `JSON.stringify` renders an `Error` as `{}` and throws outright on the
 * cycles the other three contain, so every surface that puts a bus payload
 * on a wire or in a column needs the same reductions. They live here so the
 * telemetry sink and the ops event tail cannot disagree about what an
 * exchange looks like once serialised.
 */

export interface SafeStringifyOptions {
  /**
   * Omit any property named `_snapshot`, at every level.
   *
   * Event authors mark sub-payloads with it when they carry the exchange's
   * own body and headers, which is payload data rather than metadata. A
   * surface that has not been asked to capture payloads drops it.
   */
  dropSnapshot?: boolean;
}

/**
 * Stringify a value, reducing what cannot be rendered honestly.
 *
 * Errors keep their name, message and stack. An exchange, a route and a
 * context each collapse to their identifier, which is what a reader can act
 * on and all that would survive the cycle anyway. A repeated object becomes
 * `"[Circular]"`. A failure to serialise even after all that returns a
 * one-field object naming the failure rather than throwing into the caller,
 * because the caller is a log sink or a live stream and neither can do
 * anything useful with the exception.
 */
export function safeStringify(
  value: unknown,
  options: SafeStringifyOptions = {},
): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (key, val: unknown) => {
      if (options.dropSnapshot === true && key === "_snapshot")
        return undefined;
      if (val instanceof Error) {
        return {
          name: val.name,
          message: val.message,
          ...(typeof val.stack === "string" ? { stack: val.stack } : {}),
        };
      }
      if (
        val &&
        typeof val === "object" &&
        "id" in val &&
        "headers" in val &&
        "body" in val &&
        "logger" in val
      ) {
        const ex = val as { id: string };
        return { exchangeId: ex.id };
      }
      if (
        val &&
        typeof val === "object" &&
        "definition" in val &&
        "context" in val
      ) {
        const route = val as { definition: { id: string } };
        return { routeId: route.definition.id };
      }
      if (
        val &&
        typeof val === "object" &&
        "contextId" in val &&
        "routes" in val
      ) {
        const ctx = val as { contextId: string };
        return { contextId: ctx.contextId };
      }
      if (val && typeof val === "object") {
        if (seen.has(val as object)) return "[Circular]";
        seen.add(val as object);
      }
      return val;
    });
  } catch (err) {
    return JSON.stringify({ _serializationError: String(err) });
  }
}
