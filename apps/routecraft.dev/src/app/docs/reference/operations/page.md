---
title: Operations
---

DSL operators with signatures and examples. {% .lead %}

```ts
.from([{ id: 'id' }, simple('x')])
.transform((s) => s + '!')
.to(log())
```

## from

```ts
from<T>(src: Source<T> | CallableSource<T> | [RouteOptions, Source<T> | CallableSource<T>]): RouteBuilder<T>
```

## transform

```ts
transform<Next>(fn: Transformer<Current, Next> | CallableTransformer<Current, Next>): RouteBuilder<Next>
```

## process

```ts
process<Next = Current>(fn: Processor<Current, Next> | CallableProcessor<Current, Next>): RouteBuilder<Next>
```

## filter

```ts
filter(fn: Filter<Current> | CallableFilter<Current>): RouteBuilder<Current>
```

## validate

```ts
validate(schema: StandardSchemaV1): RouteBuilder<Current>
```

## split

```ts
split<Item = Current extends Array<infer U> ? U : never>(fn?: Splitter<Current, Item> | CallableSplitter<Current, Item>): RouteBuilder<Item>
```

## aggregate

```ts
aggregate<R>(fn: Aggregator<Current, R> | CallableAggregator<Current, R>): RouteBuilder<R>
```

## enrich

```ts
enrich<R = Current>(enricher: Enricher<Current, Partial<R>> | CallableEnricher<Current, Partial<R>>, aggregator?: EnrichAggregator<Current, Partial<R>>): RouteBuilder<R>
```

## tap

```ts
tap(fn: Tap<Current> | CallableTap<Current>): RouteBuilder<Current>
```

## to

```ts
to(dest: Destination<Current> | CallableDestination<Current>): RouteBuilder<Current>
```
