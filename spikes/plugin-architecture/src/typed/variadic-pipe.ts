/** Unlimited heterogeneous pipe for independently typed operators.
 * It intentionally does not promise contextual inference for inline lambdas.
 * For that, use E's .through() or its installed named methods.
 */
type Fn = (value: never) => unknown;
type Checked<A, F extends readonly Fn[]> = F extends readonly [
  infer H extends Fn,
  ...infer T extends readonly Fn[],
]
  ? H extends (value: A) => infer B
    ? readonly [H, ...Checked<B, T>]
    : never
  : readonly [];
type Result<A, F extends readonly Fn[]> = F extends readonly [
  infer H extends Fn,
  ...infer T extends readonly Fn[],
]
  ? H extends (value: A) => infer B
    ? Result<B, T>
    : never
  : A;
export function variadicPipe<A, const F extends readonly Fn[]>(
  value: A,
  ...ops: F & Checked<A, F>
): Result<A, F> {
  let result: unknown = value;
  for (const op of ops) result = (op as (value: unknown) => unknown)(result);
  return result as Result<A, F>;
}
