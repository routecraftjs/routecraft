/** Encoding E: installed type lambdas with checked generic implementations. */
export interface MethodFamily {
  readonly Body: unknown;
  readonly Plugins: readonly Extension[];
  readonly methods: object;
}
export type Apply<
  F extends MethodFamily,
  B,
  P extends readonly Extension[],
> = (F & { readonly Body: B; readonly Plugins: P })["methods"];
export interface Extension<F extends MethodFamily = MethodFamily> {
  readonly name: string;
  create<B, P extends readonly Extension[]>(host: Cursor<B, P>): Apply<F, B, P>;
}
type Intersect<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;
type MethodOf<E, B, P extends readonly Extension[]> =
  E extends Extension<infer F> ? Apply<F, B, P> : never;
// Intersect boxes, not method unions: an uncertain plugin must remain a union.
type Boxes<P extends readonly Extension[], B> = Intersect<
  {
    [K in keyof P]: { methods: MethodOf<P[K], B, P> };
  }[number]
>;
type Methods<P extends readonly Extension[], B> =
  Boxes<P, B> extends { methods: infer M } ? M : object;
export type Chain<B, P extends readonly Extension[]> = P extends unknown
  ? Cursor<B, P> & Methods<P, B>
  : never;
export type Cursor<B, P extends readonly Extension[]> = CursorImpl<B, P>;
class CursorImpl<B, P extends readonly Extension[]> {
  constructor(
    readonly plugins: P,
    private readonly evaluate: () => Promise<B>,
  ) {}
  run(): Promise<B> {
    return this.evaluate();
  }
  map<R>(fn: (body: B) => R): Chain<Awaited<R>, P> {
    return assemble<Awaited<R>, P>(
      this.plugins,
      async (): Promise<Awaited<R>> => await fn(await this.evaluate()),
    );
  }
  keep(predicate: (body: B) => boolean): Chain<B, P> {
    return assemble(this.plugins, async () => {
      const body = await this.evaluate();
      if (!predicate(body)) throw new Error("filtered");
      return body;
    });
  }
  through<R>(op: (input: Chain<B, P>) => R): R {
    return op(this as unknown as Chain<B, P>);
  }
}
function assemble<B, P extends readonly Extension[]>(
  plugins: P,
  run: () => Promise<B>,
): Chain<B, P> {
  const host = new CursorImpl(plugins, run);
  for (const plugin of plugins) {
    const methods = plugin.create(host);
    const seen = new Set<PropertyKey>();
    // Include non-enumerable and inherited implementation methods as well.
    // Bind to the implementation object so class methods keep their receiver.
    for (
      let owner: object | null = methods;
      owner && owner !== Object.prototype;
      owner = Object.getPrototypeOf(owner) as object | null
    ) {
      for (const key of Reflect.ownKeys(owner)) {
        if ((key === "constructor" && owner !== methods) || seen.has(key))
          continue;
        seen.add(key);
        if (key in host) throw new Error(`DSL collision: ${String(key)}`);
        const descriptor = Object.getOwnPropertyDescriptor(owner, key)!;
        if (typeof descriptor.value === "function")
          descriptor.value = descriptor.value.bind(methods);
        if (descriptor.get) descriptor.get = descriptor.get.bind(methods);
        if (descriptor.set) descriptor.set = descriptor.set.bind(methods);
        Object.defineProperty(host, key, descriptor);
      }
    }
  }
  return host as Chain<B, P>;
}
export function from<B, const P extends readonly Extension[]>(
  body: B,
  plugins: P & (number extends P["length"] ? never : unknown),
): Chain<Awaited<B>, P> {
  return assemble(plugins, () => Promise.resolve(body));
}
type Operations<B, P extends readonly Extension[]> = {
  transform<R>(fn: (body: B) => R): Chain<Awaited<R>, P>;
  filter(predicate: (body: B) => boolean): Chain<B, P>;
};
export interface OperationsFamily extends MethodFamily {
  readonly methods: Operations<this["Body"], this["Plugins"]>;
}
export const operations: Extension<OperationsFamily> = {
  name: "operations",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): Operations<B, P> => ({
    transform: <R>(fn: (body: B) => R) => host.map(fn),
    filter: (predicate) => host.keep(predicate),
  }),
};
type Stranger<B, P extends readonly Extension[]> = {
  pair(): Chain<readonly [B, B], P>;
};
export interface StrangerFamily extends MethodFamily {
  readonly methods: Stranger<this["Body"], this["Plugins"]>;
}
export const stranger: Extension<StrangerFamily> = {
  name: "stranger",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): Stranger<B, P> => ({
    pair: () => host.map((body) => [body, body] as const),
  }),
};
