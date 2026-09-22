import { createHash } from "node:crypto";
import { Fault } from "./contracts.ts";
/**
 * The persistence codec: what may cross the store, and in what form.
 *
 * Plain JSON data only, with one envelope. A `Date` is the one value bodies
 * routinely hold that JSON cannot carry, so it travels as `{ "$date": iso }`
 * and comes back a `Date`. Everything else that is not plain data is refused
 * by name rather than silently downgraded, because a `Map` that resumes as
 * `{}` and a `Date` that resumes as a string are the kind of failure an
 * approver discovers days later. The rules are the shipped ones
 * (`deferral/serialize.ts`): a function, a symbol, a bigint, a non-finite
 * number, a class instance, a cycle, a value marked secret, a symbol-keyed or
 * non-enumerable own property, a named property on an array, a `Date`
 * subclass or a `Date` carrying properties, and the reserved envelope key are
 * all refused; own keys are accumulated on a null prototype so `__proto__`
 * survives as data both ways (accumulated on a null prototype on the way in,
 * defined as an own key on an ordinary object on the way back); `-0` is
 * normalised; and a corrupt envelope is refused on the way back rather than
 * revived as an invalid `Date`.
 */
export const DATE_TAG = "$date";
/** Brand for a value that must never reach a store. Membership, not a property, so it cannot be copied off. */
const secrets = new WeakSet<object>();
export function markSecret<T extends object>(value: T): T {
  secrets.add(value);
  return value;
}
export function isSecret(value: unknown): boolean {
  return typeof value === "object" && value !== null && secrets.has(value);
}
function refuse(owner: string, path: string, what: string): Fault {
  return new Fault(owner, "NOT_PERSISTABLE", `${path} holds ${what}`);
}
export function encode(value: unknown, owner: string, path = "value"): unknown {
  return walk(value, owner, path, new Set());
}
function walk(
  value: unknown,
  owner: string,
  path: string,
  seen: Set<object>,
): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value))
        throw refuse(owner, path, "a non-finite number");
      // Normalised so the persisted form does not depend on which backend serialised it.
      return Object.is(value, -0) ? 0 : value;
    case "undefined":
      return undefined;
    case "function":
      throw refuse(owner, path, "a function");
    case "symbol":
      throw refuse(owner, path, "a symbol");
    case "bigint":
      throw refuse(owner, path, "a bigint");
  }
  const object = value as object;
  if (secrets.has(object)) throw refuse(owner, path, "a secret");
  if (seen.has(object)) throw refuse(owner, path, "a cycle");
  seen.add(object);
  try {
    if (Object.getOwnPropertySymbols(object).length)
      throw refuse(owner, path, "a symbol-keyed property");
    if (object instanceof Date) {
      if (Object.getPrototypeOf(object) !== Date.prototype)
        throw refuse(owner, path, "a Date subclass");
      if (Number.isNaN(object.getTime()))
        throw refuse(owner, path, "an invalid Date");
      if (Object.getOwnPropertyNames(object).length)
        throw refuse(owner, path, "a Date carrying extra properties");
      return { [DATE_TAG]: object.toISOString() };
    }
    if (Array.isArray(object)) {
      const named = Object.getOwnPropertyNames(object).filter(
        (k) => k !== "length" && !/^(0|[1-9]\d*)$/.test(k),
      );
      if (named.length)
        throw refuse(owner, path, `a named array property (${named[0]})`);
      return object.map(
        (v, i) => walk(v, owner, `${path}[${i}]`, seen) ?? null,
      );
    }
    const proto = Object.getPrototypeOf(object) as object | null;
    if (proto !== Object.prototype && proto !== null)
      throw refuse(
        owner,
        path,
        `an instance of ${(proto as { constructor?: { name?: string } }).constructor?.name ?? "an unknown class"}`,
      );
    const names = Object.getOwnPropertyNames(object);
    for (const name of names)
      if (!Object.prototype.propertyIsEnumerable.call(object, name))
        throw refuse(owner, path, `a non-enumerable property (${name})`);
    if (names.length === 1 && names[0] === DATE_TAG)
      throw refuse(owner, path, "the reserved date envelope");
    // Null prototype: `__proto__` is an ordinary own key on anything parsed from JSON, and assigning it on `{}` hits the setter.
    const out: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of names) {
      const encoded = walk(
        (object as Record<string, unknown>)[key],
        owner,
        `${path}.${key}`,
        seen,
      );
      if (encoded !== undefined) out[key] = encoded;
    }
    return out;
  } finally {
    seen.delete(object);
  }
}
/** The read half: revive the envelopes `encode` wrote, and refuse one that was corrupted in the store. */
export function decode(value: unknown, path = "value"): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((v, i) => decode(v, `${path}[${i}]`));
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === DATE_TAG) {
    const raw = record[DATE_TAG];
    const revived = typeof raw === "string" ? new Date(raw) : new Date(NaN);
    if (Number.isNaN(revived.getTime()))
      throw new Fault(
        "codec",
        "CORRUPT_ENVELOPE",
        `${path} holds a date envelope that is not a date`,
      );
    return revived;
  }
  // An ordinary prototype on the way back, as shipped: a null-prototype body breaks `instanceof Object` and `hasOwnProperty` call sites. `__proto__` is defined as an own key, not assigned.
  const out: Record<string, unknown> = {};
  for (const key of keys)
    Object.defineProperty(out, key, {
      value: decode(record[key], `${path}.${key}`),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return out;
}
/**
 * Deterministic rendering with object keys sorted at every depth, so two
 * structurally equal values fingerprint alike whatever their insertion
 * order or which backend round-tripped them.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(",")}}`;
}
export function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(value === undefined ? "absent" : canonical(value), "utf8")
    .digest("hex");
}
