# Clean-room validation of the plugin-architecture spike

Counter-examples and reproductions behind
[`../plugin-architecture/docs/VALIDATION.md`](../plugin-architecture/docs/VALIDATION.md).
Throwaway, ships nothing, and depends only on the spike's contracts.

```bash
bun test          # 22 tests
bunx tsc --noEmit # strict, same settings as the spike
cd i1 && bunx tsc --noEmit -p tsconfig.json   # the I1 counter-example
```

| File | What it settles |
|---|---|
| `src/e-hkt.ts`, `src/e-hkt.check.ts` | F8's dichotomy is false: fluent AND body-typed AND plugin-extensible AND sound |
| `src/scale.check.ts` | 40 steps, a 40-deep chain, 1.3s of `tsc` |
| `src/a-exchange.ts`, `.check.ts` | `ex.deferral` survives, by name, and declining removes it from the type |
| `src/c-unified.ts`, `.check.ts` | One declarative shape for all five intervention points |
| `src/d-variadic.ts`, `.check.ts` | The variadic `pipe` as a checked negative, plus a curried form with no arity limit |
| `src/e-constraints.ts` | Unmatched ordering constraints recorded rather than swallowed |
| `test/break-it.test.ts` | Four things the spike's contracts cannot express |
| `test/spike-defects.test.ts` | Eight untested defects in the spike, and one claim of mine it refutes |
| `i1/stranger.ts` | A third party writing a server plugin today, with no private import |
