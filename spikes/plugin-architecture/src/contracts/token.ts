/**
 * A typed lookup key that carries its value type without a global interface.
 *
 * The alternative is declaration merging on a shared registry interface, which
 * the framework uses today in 44 places. A token keeps the type with the
 * import instead, so two packages cannot collide in one global namespace and
 * nothing depends on which module loaded first.
 */
declare const TOKEN_TYPE: unique symbol;

export interface Token<T> {
  readonly key: symbol;
  readonly name: string;
  readonly [TOKEN_TYPE]?: T;
}

export function token<T>(name: string): Token<T> {
  return { key: Symbol.for(name), name };
}
