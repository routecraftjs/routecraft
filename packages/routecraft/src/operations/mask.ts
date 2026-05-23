import { type CallableTransformer } from "./transform.ts";
import { getPath, hasPath, setPath } from "./field-paths.ts";

/**
 * Obfuscates a single field value. Receives the current value and the whole
 * record it belongs to (for context), and returns the value to show in its
 * place. Pure with respect to identity: `mask` never looks at the principal.
 *
 * @experimental
 */
export type MaskFn = (value: unknown, record: unknown) => unknown;

/**
 * Map of dot-path -> obfuscation function. Only the listed fields are
 * rewritten; every other field is left as-is.
 *
 * @experimental
 */
export type MaskRules = Record<string, MaskFn>;

function maskRecord<R>(record: R, rules: MaskRules): R {
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
 * Returns a {@link CallableTransformer}, so drop it straight into
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
export function mask<T>(rules: MaskRules): CallableTransformer<T, T> {
  return (body) => {
    if (Array.isArray(body)) {
      return body.map((item) =>
        item !== null && typeof item === "object"
          ? maskRecord(item, rules)
          : item,
      ) as T;
    }
    return (
      body !== null && typeof body === "object" ? maskRecord(body, rules) : body
    ) as T;
  };
}
