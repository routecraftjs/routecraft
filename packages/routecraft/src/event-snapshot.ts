import type { ExchangeSnapshot } from "./types.ts";
import type { Principal } from "./principal.ts";
import { principalRef } from "./kernel/continuation/principal-ref.ts";
import { BRAND, isBranded } from "./brand.ts";

/** The header the verified principal rides on (`HeadersKeys.AUTH_PRINCIPAL`). */
const PRINCIPAL_HEADER = "routecraft.auth.principal";

/** What stands in a snapshot for a value `structuredClone` refuses. */
const UNSERIALIZABLE = Object.freeze({ unserializable: true });

/** What stands in a snapshot for a value branded a `Secret`. */
const WITHHELD = Object.freeze({ secret: true });

const NO_NAMES: ReadonlySet<string> = new Set();

/**
 * The frozen copy of an exchange an opted-in subscriber receives.
 *
 * Secret headers are left out before anything is copied, so the credential
 * is never cloned. A secret name is matched at every depth of a header's
 * value, because a door keeps the wire headers it received as a map under
 * one header of its own. The principal is reduced to its reference, and a
 * value branded a `Secret` is withheld wherever it sits. The rest is
 * deep-copied, so a subscriber holds what the exchange was when the copy was
 * made and can change nothing on it.
 *
 * @param exchange - The live exchange the event names
 * @param secret - Header names to leave out, lowercased
 * @returns The snapshot
 *
 * @internal
 */
export function snapshotOf(
  exchange: {
    readonly id: string;
    readonly headers: Readonly<Record<string, unknown>>;
    readonly body: unknown;
  },
  secret: ReadonlySet<string>,
): ExchangeSnapshot {
  const headers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(exchange.headers)) {
    if (secret.has(name.toLowerCase())) continue;
    headers[name] =
      name === PRINCIPAL_HEADER && value !== null && typeof value === "object"
        ? Object.freeze(principalRef(value as Principal))
        : copyOf(value, secret);
  }
  return Object.freeze({
    id: exchange.id,
    headers: Object.freeze(headers),
    body: copyOf(exchange.body, NO_NAMES),
  });
}

function copyOf(value: unknown, secret: ReadonlySet<string>): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "function" || typeof value === "symbol"
      ? UNSERIALIZABLE
      : value;
  }
  // One guard for everything a value can do while it is read: a getter that
  // throws, a host object the clone refuses.
  try {
    return deepFreeze(
      structuredClone(withoutSecrets(value, secret, new Map())),
    );
  } catch {
    return UNSERIALIZABLE;
  }
}

/**
 * A value with every `Secret` withheld and every secret-named entry left
 * out, at any depth. Arrays, Maps, Sets and ordinary objects are walked,
 * because the clone copies what they hold; a platform object (a Date, a
 * stream, a typed array) is the clone's to copy or refuse. Memory shared
 * with the live exchange is refused here, since the clone would share it too.
 */
function withoutSecrets(
  value: unknown,
  secret: ReadonlySet<string>,
  seen: Map<object, unknown>,
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (isBranded(value, BRAND.Secret)) return WITHHELD;
  const known = seen.get(value);
  if (known !== undefined) return known;
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    seen.set(value, items);
    for (const item of value) items.push(withoutSecrets(item, secret, seen));
    return items;
  }
  if (value instanceof Map) {
    const kept = new Map<unknown, unknown>();
    seen.set(value, kept);
    for (const [key, entry] of value) {
      if (typeof key === "string" && secret.has(key.toLowerCase())) continue;
      kept.set(
        withoutSecrets(key, secret, seen),
        withoutSecrets(entry, secret, seen),
      );
    }
    return kept;
  }
  if (value instanceof Set) {
    const kept = new Set<unknown>();
    seen.set(value, kept);
    for (const item of value) kept.add(withoutSecrets(item, secret, seen));
    return kept;
  }
  if (sharesMemory(value)) return UNSERIALIZABLE;
  if (!isOrdinaryObject(value)) return value;
  const entries: Record<string, unknown> = {};
  seen.set(value, entries);
  for (const [name, entry] of Object.entries(value)) {
    if (secret.has(name.toLowerCase())) continue;
    entries[name] = withoutSecrets(entry, secret, seen);
  }
  return entries;
}

/**
 * A plain object or a class instance, which the clone copies entry by entry.
 * A platform object names itself in its string tag.
 */
function isOrdinaryObject(value: object): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function sharesMemory(value: object): boolean {
  if (typeof SharedArrayBuffer === "undefined") return false;
  if (value instanceof SharedArrayBuffer) return true;
  return ArrayBuffer.isView(value) && value.buffer instanceof SharedArrayBuffer;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  // A typed array with elements cannot be frozen, and a Map or Set is not
  // made immutable by it: those stay writable on the copy, never on the
  // exchange.
  if (ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      deepFreeze(key);
      deepFreeze(entry);
    }
  } else if (value instanceof Set) {
    for (const item of value) deepFreeze(item);
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
