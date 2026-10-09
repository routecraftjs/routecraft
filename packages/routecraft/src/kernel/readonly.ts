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
