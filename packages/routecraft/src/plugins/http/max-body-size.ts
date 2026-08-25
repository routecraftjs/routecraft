import { rcError } from "../../error";

/**
 * The `maxBodySize` ceiling, shared by the http plugin's inbound request cap
 * and the `http()` client's response cap.
 *
 * One definition rather than two literals that happen to agree: the reference
 * pages, the `RC5061` suggestion and the changelog all tell readers the two
 * sides are the same number, and a promise stated in four documents needs
 * something that breaks when it stops being true.
 */
export const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024;

/**
 * Resolve a configured `maxBodySize` against the shared default.
 *
 * `Infinity` is the named way to say "no limit". It is spelled out rather
 * than reached through a falsy value because the two readings of `0` are
 * opposites: it looks like "unbounded" and would behave as "reject
 * everything". Zero and negatives are therefore refused outright, which also
 * means a programmatically built options object cannot arrive at "no limit"
 * by accident.
 *
 * @param subject Prefix naming the caller for the error message, for example
 * `"http() client"` or `"httpPlugin"`.
 * @throws RoutecraftError RC5003 when the value is neither a positive integer
 * nor `Infinity`.
 */
export function resolveMaxBodySize(
  value: number | undefined,
  subject: string,
): number {
  if (value === undefined) return DEFAULT_MAX_BODY_SIZE;
  if (value === Number.POSITIVE_INFINITY) return value;
  if (!Number.isInteger(value) || value <= 0) {
    throw rcError("RC5003", undefined, {
      message: `${subject}: invalid maxBodySize ${String(value)}. Pass a positive integer (bytes), or Infinity for no limit.`,
    });
  }
  return value;
}

/**
 * The declared `Content-Length` when it is over `max`, otherwise `undefined`.
 *
 * An absent or unparseable declaration is not a pass, it is simply no
 * information: both sides still have to bound what actually arrives.
 */
export function declaredLengthOver(
  header: string | null | undefined,
  max: number,
): number | undefined {
  const declared = parseInt(header ?? "", 10);
  return !isNaN(declared) && declared > max ? declared : undefined;
}
