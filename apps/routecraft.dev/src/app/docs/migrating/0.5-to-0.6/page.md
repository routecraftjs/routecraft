---
title: Migrating from 0.5.x to 0.6.0
---

What changed between Routecraft 0.5.x and 0.6.0, and how to update. {% .lead %}

The headline change in 0.6.0 is **Exchange immutability**. Every `Exchange<T>` field is now `readonly`, and `DefaultExchange` shallow-freezes the wrapper, headers, and principal at construction. Code that mutated the parameter inside `.process()`, `.enrich()`, or a custom `WrapperStep` will fail to compile (parameter is `Readonly<>`) and fail at runtime in strict mode (`TypeError` on a frozen field).

Migration is mechanical: replace each mutation with a spread.

---

## 1. `.process()` callbacks

**Before (0.5.x):**

```ts
.process((exchange) => {
  exchange.body = { ...exchange.body, hello: "world" };
  exchange.headers["x-stage"] = "processed";
  return exchange;
})
```

**After (0.6.0):**

```ts
.process((exchange) => ({
  ...exchange,
  body: { ...exchange.body, hello: "world" },
  headers: { ...exchange.headers, "x-stage": "processed" },
}))
```

The framework re-wraps the returned plain object back into a proper instance via `DefaultExchange.rewrap`, preserving the context binding and route binding. Identity (`exchange.id`) is preserved across the rewrap so telemetry stays correlated.

Returning the same `exchange` unchanged is still a valid no-op pass-through.

---

## 2. `.enrich()` aggregators

If you wrote a custom aggregator for `.enrich(destination, customAggregator)`, replace mutations with a spread the same way. The built-in aggregators (`only`, `replace`, `none`, `defaultEnrichAggregator`) already follow the new contract.

**Before:**

```ts
const myAggregator = (original, enrichmentData) => {
  original.body = { ...original.body, ...enrichmentData };
  return original;
};
```

**After:**

```ts
const myAggregator = (original, enrichmentData) => ({
  ...original,
  body: { ...original.body, ...enrichmentData },
});
```

---

## 3. Custom `WrapperStep` subclasses

If you authored a wrapper that mutated the exchange in its `runInner` (for example a custom `.error()`-style recovery wrapper), build the recovered exchange via `DefaultExchange.rewrap` and push it onto `innerQueue` so the wrapper template method relays it to the rest of the pipeline.

**Before:**

```ts
protected override async runInner(exchange, innerQueue) {
  try {
    await this.inner.execute(exchange, [], innerQueue);
    return "ok";
  } catch {
    (exchange as { body?: unknown }).body = "recovered";
    innerQueue.length = 0;
    return "recovered";
  }
}
```

**After:**

```ts
protected override async runInner(exchange, innerQueue) {
  try {
    await this.inner.execute(exchange, [], innerQueue);
    return "ok";
  } catch {
    innerQueue.length = 0;
    innerQueue.push({
      exchange: DefaultExchange.rewrap(exchange, { body: "recovered" }),
      steps: [],
    });
    return "recovered";
  }
}
```

The first-party `ErrorWrapperStep` shipped with the framework already uses this pattern; this only affects you if you authored your own wrapper subclass.

---

## 4. The `routecraft.dropped` header is gone

Drop signalling for `filter`, `choice` (halt + unmatched), and the synthetic parse-step drop branch moved off `exchange.headers["routecraft.dropped"]` (which would fail because headers are frozen) to a `WeakSet` accessed via two new internal helpers.

If you forked an operation and wrote `exchange.headers["routecraft.dropped"] = true` to mark a drop, replace it with `markDropped(exchange)`. To check, use `isDropped(exchange)`. Both are exported as `@internal` and intended for adapter / operation authors only.

```ts
import { markDropped, isDropped } from "@routecraft/routecraft";

// drop:
markDropped(exchange);
return; // do not push to queue

// later, the engine checks:
if (isDropped(exchange)) {
  /* ... */
}
```

The drop signal is keyed on the **instance**, not on the logical exchange. After `DefaultExchange.rewrap`, the new instance is not dropped. This is intentional: `filter` / `halt` / parse-drop all `markDropped` and then return without pushing, so the rewrapped exchange never reaches a downstream step. If you need to test drop behaviour, assert on the exchange the engine actually sees, not on a derived rewrap.

---

## 5. The `routecraft.startedAt` header is gone

Child exchange start timestamps used by `aggregate` for duration emission moved from `exchange.headers["routecraft.startedAt"]` to a pair of helpers: `setStartedAt(exchange, ts)` / `getStartedAt(exchange)`. These store on the exchange's internals so the value survives `rewrap`, and they are framework-internal (not exported via the package entry).

If you forked the engine or wrote a custom step that read or wrote `routecraft.startedAt`, switch to the helpers (imported via the package's relative path inside the `routecraft` package itself; outside the package, the headers approach was never officially supported).

---

## 6. New API: `DefaultExchange.rewrap`

`DefaultExchange.rewrap(prev, partial)` is the framework helper that constructs a new frozen instance from a previous one plus optional field overrides. The engine calls it for you when normalising plain spreads from `.process()` / aggregators; you only need it directly if you write a custom step or operation.

```ts
import { DefaultExchange } from "@routecraft/routecraft";

const next = DefaultExchange.rewrap(prev, { body: newBody });
const withHeaders = DefaultExchange.rewrap(prev, {
  headers: { ...prev.headers, "x-key": "value" },
});
```

Internals (context, route binding, parse hooks, child startedAt) are shared by reference between `prev` and `next`, so a write on either is visible on the other. The logger is reused for the same reason: bindings derive from id / contextId / route / correlationId, all of which `rewrap` preserves.

`principal` follows `?? prev.principal` semantics: passing `undefined` does **not** clear the principal. Pass an explicit `Principal` to set it.

---

## 7. Tap snapshots no longer share body or principal references

`tap` already deep-cloned body before 0.6.0. The same now applies to `principal`: a tap snapshot's principal is a `structuredClone` of the main exchange's principal, so a downstream `.process()` that mutates `principal.claims` cannot leak the mutation into the tap. Headers are framework-immutable (shallow-frozen) and shared by reference, which is safe.

This change is observable only if you previously held onto a reference to `tap`'s exchange and inspected its principal claims after the main flow had run a downstream step. The new semantics match what the test suite already expected.

---

## 8. Type-system impact

If you have `unknown`-typed code that mutates exchanges via `as any` casts, those casts now fail at runtime (frozen fields throw `TypeError` in strict mode, which the package runs in). Replace each cast with a spread.

Adapter authors: `Processor<T, R>.process(exchange: Exchange<T>): Exchange<R>` now receives a `Readonly<Exchange<T>>` parameter. The signature is unchanged in shape but TypeScript will reject any reassignment to fields on `exchange`.

---

## 9. Verification

The contract is asserted in `packages/routecraft/test/exchange-immutability.test.ts`:

- Instances are frozen (`Object.isFrozen(exchange)`).
- Mutation via cast throws `TypeError`.
- Spread updates produce fresh frozen instances; identity (`id`) is preserved.
- Returning the same exchange unchanged is a no-op pass-through.
- `DefaultExchange.rewrap` honours an explicit `body: undefined`.
- Route and context binding survive `rewrap`.
- `markDropped` is per-instance and does not carry forward through `rewrap`.

If you have integration tests asserting that a `.process()` callback's mutation is visible downstream, they will need to be rewritten in the spread style alongside your production code.
