import { createHash } from "node:crypto";

/**
 * Derive a stable SHA-256 hex digest from an exchange body by hashing its
 * JSON serialisation. This is the shared default key derivation behind
 * `.cache()` and `.dedupe()` when no explicit `key` function is supplied,
 * so the two operations agree on what "the same body" means.
 *
 * Works for JSON-shaped bodies: primitives, arrays, and plain objects with
 * string keys. It does NOT canonicalise object key order, so two objects
 * with the same entries in a different order hash differently; supply an
 * explicit `key` when a stable identity must survive key reordering.
 *
 * Throws a plain `Error` when the body is not JSON-serialisable: a
 * top-level `undefined`, function, or symbol (which `JSON.stringify`
 * renders as `undefined`), or a `BigInt` / circular reference (which it
 * throws on). Callers translate the throw into their operation-specific
 * `RoutecraftError` with an actionable message, so the failure points the
 * user at the right `key` option.
 *
 * Performance: this serialises and hashes the body on every call. For hot
 * paths or large bodies, supply a `key` that returns a stable identifier
 * already to hand (an id field, a content hash in a header) to avoid the
 * re-serialise and re-hash.
 *
 * @internal
 */
export function hashExchangeBody(body: unknown): string {
  const stringified = JSON.stringify(body);
  if (stringified === undefined) {
    throw new Error(
      "Exchange body is not JSON-serialisable (top-level undefined, function, or symbol).",
    );
  }
  return createHash("sha256").update(stringified).digest("hex");
}
