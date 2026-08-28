/**
 * Runtime guards for the two web streaming primitives.
 *
 * Neither has anything to do with any one adapter or plugin: they answer
 * "what kind of value is this" about platform types, which is the same job
 * `isThenable` does next door. Kept here so the next consumer that needs one
 * imports a shared guard rather than reaching into a plugin it does not
 * depend on, or hand-rolling a fourth copy of the `Symbol.asyncIterator`
 * probe whose `typeof` half is the part people drop.
 */
export function isReadableStream(
  value: unknown,
): value is ReadableStream<Uint8Array> {
  return (
    typeof ReadableStream !== "undefined" && value instanceof ReadableStream
  );
}

export function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}
