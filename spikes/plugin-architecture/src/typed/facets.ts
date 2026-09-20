import type { Exchange } from "../contracts/index.ts";
type Factories = Record<string, (ex: Exchange) => unknown>;
type Facets<F extends Factories> = {
  readonly [K in keyof F]: string extends keyof F
    ? ReturnType<F[K]> | undefined
    : ReturnType<F[K]>;
};
/** Installed factory map is both runtime construction and the type source. */
export function withFacets<B, const F extends Factories>(
  ex: Exchange<B>,
  factories: F,
): Exchange<B> & Facets<F> {
  for (const [name, create] of Object.entries(factories)) {
    if (name in ex) throw new Error(`Exchange facet collision: ${name}`);
    Object.defineProperty(ex, name, {
      value: create(ex),
      enumerable: true,
      writable: false,
    });
  }
  return ex as Exchange<B> & Facets<F>;
}
