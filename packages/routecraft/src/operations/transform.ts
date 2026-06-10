import { type Adapter, type Step, type StepOutcome } from "../types.ts";
import { type Exchange, OperationType, DefaultExchange } from "../exchange.ts";

/**
 * Function form of a transformer: maps the body to a new value. Headers are unchanged.
 * Use with `.transform(transformer)`. Prefer over `.process()` when only the body changes.
 * The current exchange is passed as a second, read-only argument so a
 * transformer can derive the new body from context (the principal, headers,
 * correlation id) without dropping to `.process()`. A transformer still
 * returns only the body; to rewrite headers or the principal use `.process()`.
 * Adding the parameter is backwards compatible: a one-argument
 * `(message) => ...` is still a valid transformer.
 * @template T - Current body type
 * @template R - Result body type (default T)
 */
export type CallableTransformer<T = unknown, R = T> = (
  message: T,
  exchange: Exchange<T>,
) => Promise<R> | R;

/**
 * Result of the field-shaping helpers (`keep`, `mask`). Generic over the
 * actual body so it preserves the precise type whether applied to a single
 * record or, element-wise, to an array of records. `T` is the record
 * (element) type in both cases, so grant predicates and mask functions always
 * see one record. Assignable to {@link CallableTransformer}, so it drops
 * straight into `.transform(...)`.
 */
export type FieldTransform<T> = <B extends T | T[]>(
  body: B,
  exchange?: Exchange<B>,
) => B;

/**
 * Transformer adapter: body-only conversion. Used with `.transform()`.
 * Headers and exchange metadata are preserved. Use `.process()` to change headers or the full exchange.
 * @template T - Current body type
 * @template R - Result body type
 */
export interface Transformer<T = unknown, R = T> extends Adapter {
  transform: CallableTransformer<T, R>;
}

/**
 * Creates a transformer from declarative field mappings. Each key in the
 * mapping corresponds to a field in the output type, with a function that
 * extracts the value from the source body.
 * Use with `.transform(mapper({...}))` or the `.map()` sugar method.
 * @template T - Source body type
 * @template R - Result body type
 * @param fieldMappings - Object mapping output field names to extractor functions
 * @returns A callable transformer that maps each field via the provided functions
 * @example
 * ```ts
 * craft()
 *   .from(source)
 *   .transform(mapper<ApiUser, DbUser>({
 *     id: (user) => user.userId,
 *     name: (user) => user.fullName,
 *   }))
 *   .to(dest)
 * ```
 */
export function mapper<T, R>(fieldMappings: {
  [K in keyof R]: (src: T) => R[K];
}): CallableTransformer<T, R> {
  return (message: T): R => {
    const result = {} as R;
    for (const key in fieldMappings) {
      const k = key as keyof R;
      result[k] = fieldMappings[k](message);
    }
    return result;
  };
}

/**
 * Step that replaces the exchange body with the result of the transformer.
 * Headers and id are unchanged.
 */
export class TransformStep<T = unknown, R = T> implements Step<
  Transformer<T, R>
> {
  operation: OperationType = OperationType.TRANSFORM;
  label?: string;
  adapter: Transformer<T, R>;

  constructor(adapter: Transformer<T, R> | CallableTransformer<T, R>) {
    this.adapter =
      typeof adapter === "function" ? { transform: adapter } : adapter;
  }

  async execute(exchange: Exchange<T>): Promise<StepOutcome> {
    const newBody = await Promise.resolve(
      this.adapter.transform(exchange.body, exchange),
    );
    return {
      kind: "continue",
      exchange: DefaultExchange.rewrap<R>(exchange, { body: newBody }),
    };
  }
}
