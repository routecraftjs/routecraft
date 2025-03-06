import { SimpleAdapter } from "./adapters/simple.ts";
import { NoopAdapter } from "./adapters/noop.ts";
import { LogAdapter } from "./adapters/log.ts";
import {
  ChannelAdapter,
  type ChannelAdapterOptions,
} from "./adapters/channel.ts";
import { TimerAdapter, type TimerOptions } from "./adapters/timer.ts";
import { ContextBuilder } from "./builder.ts";
import { RouteBuilder } from "./builder.ts";
import { type CallableTransformer } from "./operations/transform.ts";

export function context(): ContextBuilder {
  return new ContextBuilder();
}

export function routes(): RouteBuilder {
  return new RouteBuilder();
}

export function simple<T = unknown>(
  producer: (() => T | Promise<T>) | T,
): SimpleAdapter<T> {
  return new SimpleAdapter<T>(
    typeof producer === "function"
      ? (producer as () => T | Promise<T>)
      : () => producer,
  );
}

export function noop<T = unknown>(): NoopAdapter<T> {
  return new NoopAdapter<T>();
}

export function log<T = unknown>(): LogAdapter<T> {
  return new LogAdapter<T>();
}

export function channel<T = unknown>(
  channel: string,
  options?: Partial<ChannelAdapterOptions>,
): ChannelAdapter<T> {
  return new ChannelAdapter<T>(channel, options);
}

export function timer(options?: TimerOptions): TimerAdapter {
  return new TimerAdapter(options);
}

/**
 * Creates a mapper function that can be used with the transform operation
 * to map message bodies to a target schema based on field mappings
 * @param fieldMappings Record of target field names to mapping functions
 * @returns A CallableTransformer function that takes a message body and returns the mapped object
 * @example
 * ```typescript
 * // Define the target schema type
 * interface Employee {
 *   employee_number: string;
 *   first_name: string;
 *   last_name: string;
 *   email: string | null;
 *   hire_date: Date | null;
 * }
 *
 * // Define field mappings from source to target schema
 * const employeeFieldMappings: Record<keyof Employee, (src: any) => any> = {
 *   employee_number: (src) => src.id,
 *   first_name: (src) => src.firstName,
 *   last_name: (src) => src.lastName,
 *   email: (src) => src.email || null,
 *   hire_date: (src) => src.hireDate ? new Date(src.hireDate) : null
 * };
 *
 * // Use the mapper in a route
 * routes()
 *   .from(someSource)
 *   .transform(mapper(employeeFieldMappings))
 *   .to(someDestination)
 *   .build();
 * ```
 */
export function mapper<T, S = unknown>(
  fieldMappings: Record<keyof T, (src: S) => T[keyof T]>,
): CallableTransformer<S, T> {
  return (message: S): T => {
    const result = {} as T;

    for (const [targetField, mapperFn] of Object.entries(fieldMappings) as [
      keyof T,
      (src: S) => T[keyof T],
    ][]) {
      result[targetField as keyof T] = mapperFn(message);
    }

    return result;
  };
}
