import { BRAND, isBranded } from "../brand.ts";
import { rcError } from "../error.ts";
import {
  type Exchange,
  type ExchangeHeaders,
  DefaultExchange,
  HeadersKeys,
} from "../exchange.ts";
import type { CraftContext } from "../context.ts";
import { markRestored } from "../auth/restored.ts";
import type { Principal } from "../auth/types.ts";
import type { SerializedExchange } from "./types.ts";

/**
 * Serialization is a security boundary, not plumbing.
 *
 * Three rules are enforced here, at suspend time, so a violation surfaces
 * on the deploy that introduced it rather than days later when an approver
 * clicks a link:
 *
 * 1. **Nothing but plain JSON data is persisted.** Functions, symbols,
 *    bigints, class instances and circular references are refused with
 *    `RC5042`. This is what keeps a live resolver from being written to the
 *    store: a `Blocks` record whose entries are functions cannot cross the
 *    boundary, so only resolved string outputs survive. Blocks declared
 *    `lifetime: "context"` are unaffected, because they live in
 *    `context.store`, which outlives the exchange and is never serialized.
 * 2. **Secrets never reach the store.** A value carrying `BRAND.Secret` is
 *    refused. The brand is reserved ahead of #526; the check is live now so
 *    the rule holds the moment `Secret` starts applying it.
 * 3. **A rehydrated principal is not a verified one.** Deserialization
 *    marks it restored rather than authentic, so `authorize()` reports
 *    `RC5043` instead of trusting a shape read off disk. See
 *    `auth/restored.ts` for why suspension is the direct route back into
 *    #355's bug class.
 *
 * ## The wire form
 *
 * Everything a backend receives is JSON data, which is what lets the
 * in-memory and sqlite backends behave identically. `Date` is the one type
 * JSON cannot carry that exchange bodies routinely hold (a mail `date`, a
 * cron tick), so it travels in a tagged envelope, {@link DATE_TAG}, and is
 * revived on the way back. An object whose only key is that tag is
 * therefore reserved; any other non-plain object (a `Uint8Array`, a `Map`,
 * a class instance) is refused rather than silently downgraded to a
 * differently-behaved object wearing the same fields.
 */

/**
 * Envelope key that carries a `Date` through JSON storage. An object whose
 * sole key is this tag is reserved by the framework and is revived as a
 * `Date` on resume.
 */
export const DATE_TAG = "$routecraft.date";

/**
 * Convert a live exchange into its persistable form.
 *
 * Exactly the two stored slots (`body`, `headers`) cross the boundary, per
 * `.standards/exchange-state-model.md`. Derivations (`id`, `principal`,
 * `logger`) are not persisted separately: `id` and `principal` already live
 * inside `headers`, and `logger` is rebuilt from runtime services on the
 * resuming process.
 *
 * The result is a detached deep copy, so the store never holds a reference
 * into an exchange a later step could still mutate.
 *
 * @param exchange - The exchange being parked.
 * @returns JSON data safe to hand to any store backend.
 * @throws RC5042 when a value in `body` or `headers` cannot be persisted.
 */
export function serializeExchange(exchange: Exchange): SerializedExchange {
  return {
    body: encode(exchange.body, "body"),
    headers: encode(exchange.headers, "headers") as Readonly<
      Record<string, unknown>
    >,
  };
}

/**
 * Rebuild a live exchange from its persisted form.
 *
 * The result is a genuine `DefaultExchange` on the resuming context, so the
 * derived accessors work immediately. The route binding is NOT restored
 * here: the resume path owns finding the route by
 * `headers["routecraft.route"]` and binding it, because only it knows which
 * context is reviving the exchange.
 *
 * @param context - The context reviving the exchange.
 * @param serialized - The stored `{ body, headers }` pair.
 * @returns A live exchange whose principal, if any, is marked restored.
 */
export function deserializeExchange(
  context: CraftContext,
  serialized: SerializedExchange,
): Exchange {
  const headers = decode(serialized.headers) as Record<string, unknown>;
  const principal = headers[HeadersKeys.AUTH_PRINCIPAL];
  if (
    principal !== undefined &&
    typeof principal === "object" &&
    principal !== null
  ) {
    headers[HeadersKeys.AUTH_PRINCIPAL] = markRestored(principal as Principal);
  }
  return new DefaultExchange(context, {
    body: decode(serialized.body),
    headers: headers as ExchangeHeaders,
  });
}

/**
 * Deep-check and copy `value` into JSON data, or throw `RC5042` naming the
 * exact path that failed.
 *
 * Walking the structure ourselves rather than round-tripping through
 * `JSON.stringify` is what makes the failure legible: the message says
 * `headers.routecraft.mail.client holds an instance of ImapFlow`, not
 * "Converting circular structure to JSON".
 *
 * `undefined` is dropped from object properties and preserved inside
 * arrays, matching JSON semantics, so a value round-trips identically on
 * every backend.
 *
 * @internal
 */
function encode(
  value: unknown,
  path: string,
  seen: Set<object> = new Set(),
): unknown {
  if (value === null || value === undefined) return value;

  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return value;
  if (kind === "number") {
    // NaN and Infinity serialize to null, which would quietly change the
    // value under a parked exchange. Refuse instead of rounding it off.
    if (!Number.isFinite(value)) {
      throw refuse(path, `a non-finite number (${String(value)})`);
    }
    return value;
  }
  if (kind === "function") throw refuse(path, "a function");
  if (kind === "symbol") throw refuse(path, "a symbol");
  if (kind === "bigint") throw refuse(path, "a bigint");

  const object = value as object;
  if (isBranded(object, BRAND.Secret)) throw refuse(path, "a Secret");
  if (seen.has(object)) throw refuse(path, "a circular reference");
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw refuse(path, "an invalid Date");
    return { [DATE_TAG]: value.toISOString() };
  }

  seen.add(object);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        encode(entry, `${path}[${index}]`, seen),
      );
    }

    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw refuse(
        path,
        `an instance of ${(object as { constructor?: { name?: string } }).constructor?.name ?? "a class"}`,
      );
    }

    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(object)) {
      if (entry === undefined) continue;
      copy[key] = encode(entry, `${path}.${key}`, seen);
    }
    return copy;
  } finally {
    seen.delete(object);
  }
}

/**
 * Revive tagged values produced by {@link encode}. Everything else is
 * returned as-is; the input is already JSON data by construction.
 *
 * @internal
 */
function decode(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);

  const entries = Object.entries(value as Record<string, unknown>);
  const tagged = entries.length === 1 && entries[0]?.[0] === DATE_TAG;
  if (tagged && typeof entries[0]?.[1] === "string") {
    return new Date(entries[0][1] as string);
  }

  const copy: Record<string, unknown> = {};
  for (const [key, entry] of entries) copy[key] = decode(entry);
  return copy;
}

/** @internal */
function refuse(path: string, what: string): Error {
  return rcError("RC5042", undefined, {
    message: `Cannot suspend: exchange ${path} holds ${what}, which cannot be persisted to the suspension store.`,
  });
}
