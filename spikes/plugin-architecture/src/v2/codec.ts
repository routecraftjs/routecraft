import { createHash } from "node:crypto";
import { Fault } from "./contracts.ts";
/**
 * The persistence codec: what may cross the store, and in what form.
 *
 * Plain JSON data only, with one envelope. A `Date` is the one value bodies
 * routinely hold that JSON cannot carry, so it travels as `{ "$date": iso }`
 * and comes back a `Date`. Everything else that is not plain data (a
 * function, a symbol, a bigint, a `Map`, a class instance, a cycle) is
 * refused by name rather than silently downgraded, because a `Map` that
 * resumes as `{}` and a `Date` that resumes as a string are the kind of
 * failure an approver discovers days later. `structuredClone` is not this
 * codec: it accepts what SQLite then flattens.
 */
export const DATE_TAG = "$date";
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
      return value;
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
  if (seen.has(object)) throw refuse(owner, path, "a cycle");
  seen.add(object);
  try {
    if (object instanceof Date) {
      if (Number.isNaN(object.getTime()))
        throw refuse(owner, path, "an invalid Date");
      return { [DATE_TAG]: object.toISOString() };
    }
    if (Array.isArray(object))
      return object.map(
        (v, i) => walk(v, owner, `${path}[${i}]`, seen) ?? null,
      );
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null)
      throw refuse(
        owner,
        path,
        `an instance of ${(proto as { constructor?: { name?: string } }).constructor?.name ?? "an unknown class"}`,
      );
    const keys = Object.keys(object);
    if (keys.length === 1 && keys[0] === DATE_TAG)
      throw refuse(owner, path, "the reserved date envelope");
    const out: Record<string, unknown> = {};
    for (const key of keys) {
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
/** The read half: revive the envelopes `encode` wrote. Total over anything a store returns. */
export function decode(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length === 1 &&
    keys[0] === DATE_TAG &&
    typeof record[DATE_TAG] === "string"
  ) {
    const revived = new Date(record[DATE_TAG]);
    if (!Number.isNaN(revived.getTime())) return revived;
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = decode(record[key]);
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
