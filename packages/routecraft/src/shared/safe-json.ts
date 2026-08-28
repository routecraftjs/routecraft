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

import { isCraftContext, isExchange, isRoute } from "../brand.ts";

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
      // The framework's own brand guards, not a shape heuristic. The
      // structural version misread any payload that happened to carry the
      // same key names, and its unguarded read through `definition` threw
      // inside the replacer for a nullish one, which collapsed the WHOLE
      // value to a serialisation error rather than losing one field. These
      // are the same guards `logger.ts` already discriminates these three
      // types with, so the two readers cannot disagree about what an
      // exchange looks like.
      if (isExchange(val)) return { exchangeId: (val as { id: string }).id };
      if (isRoute(val)) {
        return {
          routeId: (val as { definition: { id: string } }).definition.id,
        };
      }
      if (isCraftContext(val)) {
        return { contextId: (val as { contextId: string }).contextId };
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
