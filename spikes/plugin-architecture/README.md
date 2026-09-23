# Plugin architecture: round-five contract spike

Base: `5dac4d97`. Authority: [ARCHITECTURE.md](ARCHITECTURE.md). The user-facing account of the direction, with figures, is [docs/direction/](docs/direction/README.md). This is the second proof of concept, not a production framework refactor.

```sh
bun install                    # repository root
cd spikes/plugin-architecture
bun run verify                 # types, acceptance, packed consumer, mutations, boundaries
bun run demo
```

The active implementation and package entry point are **`src/v2/index.ts`**. It installs the same descriptors used by the body-typed fluent DSL, compiles explicit `StepOutcome` instructions, resolves ports, binds ordered handlers/wrappers, and owns source/exchange/stream lifetimes. A semantic continuation port is implemented above an asynchronous-capable atomic record contract; SQLite supplies the exercised persistent backend.

The headline test parks inside a nested agent instruction, verifies no suffix effect, kills that process with SIGKILL, rejects a changed plan, and resumes from another process across separate session and deferral databases. It checks the exact effect log and conversation messages. Additional child-process tests kill a writer between record/index statements and synchronize two CAS contenders behind a barrier.

See [round-five report](reviews/ASTRA-ROUND-FIVE.md) for the acceptance ledger, assumptions and limits. See [evidence instructions](validation/round-two/README.md) for reproduction details.

## Historical material

The old `src/contracts`, `kernel`, `runtime`, `plugins`, `builder` and `typed` trees remain for comparison. They are not the active package implementation. The eight old test files are renamed `*.historical.ts`: they remain typechecked but no longer contribute green defect-characterisation tests to the acceptance count. Both earlier DSL encodings remain available in their original locations. The former README is preserved in [reviews/ROUND-ONE-README.md](reviews/ROUND-ONE-README.md).

## Deliberate limits

This spike does not promise exactly-once arbitrary external effects, distributed transactions across the two databases, automatic recovery after crashing an already-claimed continuation, cryptographic principal validation, or migration of changed plans. The report spells out those limits. Timeout guarantees apply to outcomes and effects that use cancellation/fencing; arbitrary JavaScript is not a sandbox.
