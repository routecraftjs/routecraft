---
title: Operators (DSL)
---

All operators with signatures and short examples. {% .lead %}

```ts
import { craft, simple, log } from '@routecraftjs/routecraft'

export default craft()
  .from([{ id: 'r' }, simple('x')])
  .transform((s) => s + '!')
  .to(log())
```

## from

```ts
from<T>(sourceOrTuple: Source<T> | CallableSource<T> | [RouteOptions, Source<T> | CallableSource<T>]): RouteBuilder<T>
```

```ts
.from([{ id: 'my-route' }, simple('payload')])
```

## transform

```ts
transform<Next>(fn: Transformer<Current, Next> | CallableTransformer<Current, Next>): RouteBuilder<Next>
```

```ts
.transform((s: string) => s.toUpperCase())
```

## process

```ts
process<Next = Current>(fn: Processor<Current, Next> | CallableProcessor<Current, Next>): RouteBuilder<Next>
```

```ts
.process((ex) => ({ ...ex, body: String(ex.body).trim() }))
```

## filter

```ts
filter(fn: Filter<Current> | CallableFilter<Current>): RouteBuilder<Current>
```

```ts
.filter((n: number) => n > 0)
```

## validate

```ts
validate(schema: StandardSchemaV1): RouteBuilder<Current>
```

```ts
.validate({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] })
```

## split

```ts
split<Item = Current extends Array<infer U> ? U : never>(fn?: Splitter<Current, Item> | CallableSplitter<Current, Item>): RouteBuilder<Item>
```

```ts
.split()
```

## aggregate

```ts
aggregate<R>(fn: Aggregator<Current, R> | CallableAggregator<Current, R>): RouteBuilder<R>
```

```ts
.aggregate((exchanges) => ({ body: exchanges.length, headers: exchanges[0].headers }))
```

## enrich

```ts
enrich<R = Current>(enricher: Enricher<Current, Partial<R>> | CallableEnricher<Current, Partial<R>>, aggregator?: EnrichAggregator<Current, Partial<R>>): RouteBuilder<R>
```

```ts
.enrich(() => ({ extra: true }))
```

## tap

```ts
tap(fn: Tap<Current> | CallableTap<Current>): RouteBuilder<Current>
```

```ts
.tap((ex) => console.log('body:', ex.body))
```

## to

```ts
to(destination: Destination<Current> | CallableDestination<Current>): RouteBuilder<Current>
```

```ts
.to(log())
```

### Optional operators (TODO)

- choice
- throttle
- idempotent
- circuit-breaker
- recipient-list
