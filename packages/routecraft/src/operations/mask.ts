import { type FieldTransform } from "./transform.ts";
import { getPath, hasPath, setPath } from "./field-paths.ts";

/**
 * Obfuscates a single field value. Receives the current value and the whole
 * record it belongs to (typed `R`), and returns the value to show in its
 * place. Pure with respect to identity: `mask` never looks at the principal.
 * `value` stays `unknown` because the value at an arbitrary dot path is not
 * statically known.
 *
 * @experimental
 */
export type MaskFn<R = unknown> = (value: unknown, record: R) => unknown;

/**
 * Map of dot-path -> obfuscation function. Only the listed fields are
 * rewritten; every other field is left as-is.
 *
 * @experimental
 */
export type MaskRules<R = unknown> = Record<string, MaskFn<R>>;

function maskRecord<R>(record: R, rules: MaskRules<R>): R {
  let out = record;
  for (const path of Object.keys(rules)) {
    if (hasPath(out, path)) {
      out = setPath(out, path, rules[path](getPath(out, path), record));
    }
  }
  return out;
}

/**
 * Transform helper that obfuscates field values, regardless of who is asking.
 * Use it for values that should never be shown verbatim at a boundary even to
 * an authorised caller, for example masking an e-mail on a public HTTP
 * response. To remove fields a caller is not allowed to see at all, compose
 * `keep` before `mask`.
 *
 * Returns a {@link FieldTransform}, so drop it straight into
 * `.transform(mask({ ... }))`. Applies to the body when it is a single
 * record, and element-wise when the body is an array of records. For a
 * wrapped collection, mask the inner array:
 * `.transform((b, ex) => ({ ...b, items: mask(rules)(b.items, ex) }))`.
 *
 * @experimental
 *
 * @example
 * ```ts
 * craft()
 *   .from(source)
 *   .transform(mask({
 *     email: (v) => maskEmail(String(v)),
 *     "card.number": (v) => "**** " + String(v).slice(-4),
 *   }))
 *   .to(dest)
 * ```
 */
export function mask<T>(rules: MaskRules<T>): FieldTransform<T> {
  const fn = (body: unknown): unknown => {
    if (Array.isArray(body)) {
      return body.map((item) =>
        item !== null && typeof item === "object"
          ? maskRecord(item as T, rules)
          : item,
      );
    }
    return body !== null && typeof body === "object"
      ? maskRecord(body as T, rules)
      : body;
  };
  return fn as unknown as FieldTransform<T>;
}
