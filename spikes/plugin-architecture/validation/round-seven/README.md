# Round seven: review probes

Executable evidence for `reviews/FABLE-REVIEW.md`. Measured on
`e5d160352e6082a1f53c43941dae06e8798a146e` with Bun 1.3.11 and TypeScript
5.9.3. Nothing under `src/v2` or `test/round-two` was changed; these scripts
observe the implementation at that head.

```sh
cd spikes/plugin-architecture
bun run validation/round-seven/guarantees.ts   # shipped guarantees vs src/v2
bun run validation/round-seven/mutants.ts      # 16 mutants the 27 do not cover
bun run validation/round-seven/scale.ts        # tsc at 5, 20 and 40 plugins
```

| Script | What it measures | Method |
|---|---|---|
| `guarantees.ts` | Behaviours the shipped framework documents in `packages/routecraft/src/deferral/types.ts`, `revive.ts`, `hash.ts`, `context.ts` and `.standards/security.md`, executed against `src/v2`. One line per probe: `REGRESSION`, `HOLDS` or `INFO`, then the observed fact | Each probe runs a real `Application`, in process, on temporary SQLite files |
| `mutants.ts` | Whether a mechanism is asserted anywhere in the acceptance suite | Same runner discipline as `validation/round-two/mutations.ts`: disposable copy, non-zero exit AND a literal `(fail)`. The packed test is excluded because it needs the repository's `node_modules` and fails for every mutant in the copy; a first run that included it reported 16/16 killed, all by that artifact |
| `scale.ts` | Type-check cost of the round-five DSL encoding under realistic plugin counts | Generates a fixture of N plugins with two methods and one facet each and a chain of M steps, then `tsc --extendedDiagnostics` per size. Check time, instantiations, types and memory are read off the compiler's own report |

Results at the measured head are quoted in the review. They are not
checked in as text here because the review is where they are interpreted;
re-run the scripts to reproduce them.

**Kept as evidence, not as a running check.** These probes ran against
`e5d16035` and drove the corrections that followed. Those corrections changed
the API they call (`deliver` takes headers, `resume` takes an id minted per
exchange, `Principal` moved to the auth plugin, the claim lease became
`claimExpiry`), so the scripts no longer run as written. Every regression they
found is now an assertion in `test/round-two/corrections.test.ts`, and every
surviving mutant in `mutants.ts` is now in `validation/round-two/mutations.ts`
with a test that kills it.
