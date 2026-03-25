import { type Adapter, type Step } from "../types.ts";
import { type Exchange, OperationType } from "../exchange.ts";

/**
 * Function form of a transformer: maps the body to a new value. Headers are unchanged.
 * Use with `.transform(transformer)`. Prefer over `.process()` when only the body changes.
 *
 * @template T - Current body type
 * @template R - Result body type (default T)
 */
export type CallableTransformer<T = unknown, R = T> = (
  message: T,
) => Promise<R> | R;

/**
 * Transformer adapter: body-only conversion. Used with `.transform()`.
 * Headers and exchange metadata are preserved. Use `.process()` to change headers or the full exchange.
 *
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
 *
 * Use with `.transform(mapper({...}))` or the `.map()` sugar method.
 *
 * @experimental
 * @template T - Source body type
 * @template R - Result body type
 * @param fieldMappings - Object mapping output field names to extractor functions
 * @returns A callable transformer that maps each field via the provided functions
 *
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
export function mapper<T, R>(
  fieldMappings: Record<keyof R, (src: T) => R[keyof R]>,
): CallableTransformer<T, R> {
  return (message: T): R => {
    const result = {} as R;
    for (const [targetField, mapperFn] of Object.entries(fieldMappings) as [
      keyof R,
      (src: T) => R[keyof R],
    ][]) {
      result[targetField as keyof R] = mapperFn(message);
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

  async execute(
    exchange: Exchange<T>,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange<R>; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    const newBody = await Promise.resolve(
      this.adapter.transform(exchange.body),
    );
    exchange.body = newBody as unknown as T;
    queue.push({
      exchange: exchange as unknown as Exchange<R>,
      steps: remainingSteps,
    });
  }
}
