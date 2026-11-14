import { rcError } from "../error.ts";

const views = new WeakMap<object, object>();

/**
 * A read-only view of an object graph a plugin inspects: the same objects,
 * read through, with every write refused (`RC1110`). Nothing is copied, so
 * the view never lags the live graph, and nothing is frozen, so the owner
 * keeps writing. A function is handed out as is, so a method called through
 * the view runs with the view as its receiver: a mutating method of an
 * array or an object meets the same refusal a write does.
 *
 * A property the owner froze is handed out as is, because a proxy may not
 * answer anything else for it.
 *
 * @param value - The graph to view
 * @param what - What the view is of, for the refusal
 * @returns The view, or `value` itself when it is not an object
 * @internal
 */
export function readonlyView<T>(value: T, what: string): T {
  if (typeof value !== "object" || value === null) return value;
  const cached = views.get(value);
  if (cached !== undefined) return cached as T;
  const refuse = (): never => {
    throw rcError("RC1110", undefined, {
      message: `${what} is read-only through the plugin view. A plugin registers routes of its own in bind and never edits another's.`,
    });
  };
  const proxy: object = new Proxy(value, {
    get(target, key) {
      const found: unknown = Reflect.get(target, key, target);
      if (typeof found === "function") return found;
      const own = Reflect.getOwnPropertyDescriptor(target, key);
      if (own !== undefined && !own.configurable && !own.writable) return found;
      return readonlyView(found, what);
    },
    set: refuse,
    deleteProperty: refuse,
    defineProperty: refuse,
    setPrototypeOf: refuse,
  });
  views.set(value, proxy);
  return proxy as T;
}

const dataViews = new WeakMap<object, object>();

function isPlainData(value: object): boolean {
  if (Array.isArray(value)) return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A read-only view of an exchange for code that reports on it and must not
 * change it: `.log()`'s level and bindings. Every write to the exchange, its
 * headers or a plain object or array reachable from its body is refused
 * (`RC1110`).
 *
 * Unlike {@link readonlyView} it also covers what the owner froze, which
 * matters here because an exchange is frozen and its body is not. An
 * instance of a class (a `Date`, a `Map`, a model with private fields) is
 * handed out as is: its methods need the real object as their receiver, so
 * it cannot be viewed, only trusted.
 *
 * @param exchange - The exchange to view
 * @param where - Where the view is handed out, for the refusal
 * @returns The view
 * @internal
 */
export function readonlyExchange<T extends object>(
  exchange: T,
  where: string,
): T {
  return dataView(exchange, where, true);
}

function dataView<T extends object>(value: T, where: string, root: boolean): T {
  const cached = dataViews.get(value);
  if (cached !== undefined) return cached as T;
  const refuse = (): never => {
    throw rcError("RC1110", undefined, {
      message: `The exchange is read-only inside ${where}. Change it in a step of its own, before or after.`,
    });
  };
  const wrap = (found: unknown): unknown => {
    if (typeof found === "function") {
      // A method of the exchange reads its private state, so it needs the
      // exchange, not the view, as its receiver.
      return root ? (found.bind(value) as unknown) : found;
    }
    if (typeof found !== "object" || found === null) return found;
    return isPlainData(found) ? dataView(found, where, false) : found;
  };
  // The view stands on an empty object of its own: a proxy must report a
  // frozen target's properties as they are, and the exchange is frozen.
  const shadow: object = Array.isArray(value)
    ? []
    : (Object.create(Object.getPrototypeOf(value) as object | null) as object);
  const proxy: object = new Proxy(shadow, {
    get: (_shadow, key) => wrap(Reflect.get(value, key, value)),
    has: (_shadow, key) => Reflect.has(value, key),
    ownKeys: () => Reflect.ownKeys(value),
    getOwnPropertyDescriptor(_shadow, key) {
      const real: PropertyDescriptor | undefined =
        Reflect.getOwnPropertyDescriptor(value, key);
      if (real === undefined) return undefined;
      if ("value" in real) real.value = wrap(real.value);
      const own = Reflect.getOwnPropertyDescriptor(shadow, key);
      if (own !== undefined && !own.configurable) {
        return { ...own, value: real.value as unknown };
      }
      return { ...real, configurable: true };
    },
    set: refuse,
    deleteProperty: refuse,
    defineProperty: refuse,
    setPrototypeOf: refuse,
    preventExtensions: refuse,
  });
  dataViews.set(value, proxy);
  return proxy as T;
}
