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
 * Step that replaces the exchange body with the result of the transformer.
 * Headers and id are unchanged.
 */
export class TransformStep<T = unknown, R = T> implements Step<
  Transformer<T, R>
> {
  operation: OperationType = OperationType.TRANSFORM;
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
