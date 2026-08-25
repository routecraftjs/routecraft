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
 * Zero and negatives are always refused rather than read as "no limit",
 * because the two readings of `0` are opposites: it looks like "unbounded"
 * and would behave as "reject everything". So an options object built
 * programmatically cannot arrive at unbounded by accident on either side.
 *
 * Whether unbounded can be asked for at all is the caller's to decide, and
 * the two sides answer differently. Outbound, the route author chose the
 * endpoint and is spending their own process on a response they asked for,
 * so `Infinity` is a legitimate opt-out. Inbound, the caller is a stranger
 * and the request is buffered whole before it can be measured, so an
 * unbounded cap means one request can exhaust the process, which is the
 * exact thing the option exists to prevent. Refusing is therefore the
 * default and permitting it is opt-in, never the other way around.
 *
 * @param subject Prefix naming the caller for the error message, for example
 * `"http() client"` or `"httpPlugin"`.
 * @param allowUnbounded Whether `Infinity` is accepted as a named opt-out.
 * Defaults to `false`.
 * @throws RoutecraftError RC5003 when the value is not a positive integer,
 * or is `Infinity` where unbounded is not permitted.
 */
export function resolveMaxBodySize(
  value: number | undefined,
  subject: string,
  { allowUnbounded = false }: { allowUnbounded?: boolean } = {},
): number {
  if (value === undefined) return DEFAULT_MAX_BODY_SIZE;
  if (allowUnbounded && value === Number.POSITIVE_INFINITY) return value;
  if (!Number.isInteger(value) || value <= 0) {
    const ways = allowUnbounded
      ? "Pass a positive integer (bytes), or Infinity for no limit."
      : "Pass a positive integer (bytes).";
    throw rcError("RC5003", undefined, {
      message: `${subject}: invalid maxBodySize ${String(value)}. ${ways}`,
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
