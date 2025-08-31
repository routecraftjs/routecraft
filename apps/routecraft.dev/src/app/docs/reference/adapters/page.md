---
title: Adapters
---

Catalog of built-in adapters and authoring guidance. {% .lead %}

## simple

```ts
simple<T>(producer: (() => T | Promise<T>) | T): SimpleAdapter<T>
```

```ts
.from([{ id: 'hello' }, simple('Hello')])
```

## log

```ts
log<T>(): LogAdapter<T>
```

```ts
.to(log())
```

## timer

```ts
timer(options?: TimerOptions): TimerAdapter
```

Options: `intervalMs`, `repeatCount`

```ts
.from([{ id: 'tick' }, timer({ intervalMs: 1000, repeatCount: 5 })])
```

## channel

```ts
channel<T = unknown>(name: string, options?: Partial<ChannelAdapterOptions>): ChannelAdapter<T>
```

```ts
.to(channel('my-channel'))
```

## fetch

```ts
fetch<T, R>(options: FetchOptions<T>): FetchAdapter<T, R>
```

```ts
.enrich(fetch({ method: 'GET', url: (ex) => `https://api/${ex.body}` }))
```

### Custom adapters

Adapters implement operation interfaces (Source, Destination, Processor) and can use `CraftContext` stores. See `packages/routecraft/src/types.ts` and `packages/routecraft/src/context.ts`.

### Next adapter (TODO)

No Next.js inbound adapter in repo yet. Document here if added.
