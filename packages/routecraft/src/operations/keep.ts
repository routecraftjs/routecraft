import { type Principal } from "../auth/types.ts";
import { type CallableTransformer } from "./transform.ts";
import { deletePath, hasPath, pickPaths } from "./field-paths.ts";

/**
 * A grant the caller must hold to keep a field. Either a role name matched
 * against `principal.roles`, or a predicate evaluated against the record and
 * the caller's principal. `self` and relationships like "manages" are written
 * as predicates; there is no magic string, `admin` is just a role name.
 *
 * @experimental
 */
export type Grant<T = unknown> =
  | string
  | ((record: T, principal: Principal | undefined) => boolean);

/**
 * Rule for one field: `true` keeps it for everyone who reaches this step, or a
 * list of grants any one of which keeps it.
 *
 * @experimental
 */
export type KeepRule<T = unknown> = true | Grant<T>[];

/**
 * Map of dot-path -> {@link KeepRule}.
 *
 * @experimental
 */
export type KeepRules<T = unknown> = Record<string, KeepRule<T>>;

/**
 * Options for {@link keep}.
 *
 * @experimental
 */
export interface KeepOptions {
  /**
   * `true` (default): strict allowlist. Only fields listed in the rules
   * survive, each kept when its grant holds; anything not listed is dropped.
   * Safe by default, a new sensitive field stays hidden until you list it.
   *
   * `false`: gate only the listed fields. A listed field is dropped when its
   * grant fails; every unlisted field passes through untouched.
   */
  strict?: boolean;
}

function holds<T>(
  rule: KeepRule<T>,
  record: T,
  principal: Principal | undefined,
): boolean {
  if (rule === true) return true;
  return rule.some((grant) =>
    typeof grant === "function"
      ? grant(record, principal)
      : (principal?.roles?.includes(grant) ?? false),
  );
}

function keepRecord<R>(
  record: R,
  rules: KeepRules<R>,
  principal: Principal | undefined,
  strict: boolean,
): R {
  if (strict) {
    const allowed: string[] = [];
    for (const path of Object.keys(rules)) {
      if (hasPath(record, path) && holds(rules[path], record, principal)) {
        allowed.push(path);
      }
    }
    return pickPaths(record, allowed);
  }
  let out = record;
  for (const path of Object.keys(rules)) {
    if (hasPath(out, path) && !holds(rules[path], out, principal)) {
      out = deletePath(out, path);
    }
  }
  return out;
}

/**
 * Transform helper that keeps fields based on the caller's grants, removing
 * the rest. This is the access-control half of field shaping: a field the
 * caller has no grant for is dropped entirely (compose `mask` after `keep` to
 * obfuscate what remains). Reads the caller from the exchange the transform
 * step now provides, so it must run on an exchange that carries a principal.
 *
 * Strict by default: only listed fields survive (use `true` to keep a field
 * for any caller). Pass `{ strict: false }` to instead gate only the listed
 * fields and pass everything else through.
 *
 * Returns a {@link CallableTransformer}, so use `.transform(keep({ ... }))`.
 * Applies to the body when it is a single record, element-wise when it is an
 * array of records. For a wrapped collection, keep the inner array:
 * `.transform((b, ex) => ({ ...b, items: keep(rules)(b.items, ex) }))`.
 *
 * @experimental
 *
 * @example
 * ```ts
 * const self = (e: Employee, p) => e.email === p?.email;
 * craft()
 *   .from(source)
 *   .transform(keep({
 *     id: true,
 *     email: true,
 *     yearlyWage: [self, "hr"],   // own salary, or the hr role
 *     internalNotes: ["hr"],      // hr only, dropped for everyone else
 *   }))
 *   .to(dest)
 * ```
 */
export function keep<T>(
  rules: KeepRules<T>,
  options: KeepOptions = {},
): CallableTransformer<T, T> {
  const strict = options.strict ?? true;
  return (body, exchange) => {
    const principal = exchange?.principal;
    if (Array.isArray(body)) {
      return body.map((item) =>
        item !== null && typeof item === "object"
          ? keepRecord(item, rules as KeepRules<unknown>, principal, strict)
          : item,
      ) as T;
    }
    return (
      body !== null && typeof body === "object"
        ? keepRecord(body, rules as KeepRules<T>, principal, strict)
        : body
    ) as T;
  };
}
