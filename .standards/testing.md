# Testing

Authoritative rules and conventions for tests in Routecraft.

---

## 1. Runners and layout

Routecraft is mid-migration from vitest to `bun:test`. Both runners coexist; new tests should default to `bun:test` unless they hit a known incompatibility (see § 1.2).

### 1.1. File placement and naming

- Unit tests: `packages/<name>/test/<feature>.test.ts` (vitest) or `packages/<name>/test/<feature>.bun.test.ts` (bun:test).
- Integration tests (real network, real subprocesses, slow setup): `packages/<name>/test/<feature>.integration.test.ts`, run via `bun run test:integration`. The default `bun run test` excludes them.
- **One feature per file.** Group tests around the unit they exercise, not by category. A test file maps to a code file (or a closely related cluster), not to "all the validation tests in the package".

The filename suffix selects the runner. `bun run test` runs both:

```sh
bun run test           # both runners (test:bun + test:vitest)
bun run test:bun       # bun:test files only (`*.bun.test.{ts,tsx}`)
bun run test:vitest    # vitest files only (`*.test.{ts,tsx}` excluding `*.bun.test.*`)
```

### 1.2. Choosing a runner

Default to `bun:test`. Stay on vitest only when the test hits a known bun:test gap:

| Reason | Status |
|---|---|
| Fake timers (`vi.useFakeTimers`, `advanceTimersByTime`) | Bun 1.3.11's `node:test` `mock.timers` is documented but not implemented. Re-migrate when Bun ships it. |
| `vi.hoisted` / `vi.importActual` complex module mocks | Different hoisting semantics; per-file workaround needed. |
| `toMatchObject` followed by access to matched fields | Bun:test mutates the actual object, replacing matched fields with matcher refs. Use a shallow-copy match or restructure the test. |
| ink-testing-library renderers | Output diffs under bun:test. Investigate later. |
| ESLint `RuleTester` | Compatibility surface to investigate. |
| `jose` remote JWKS over real HTTP | `fetchImpl` resolves differently under Bun. Investigate later. |

When migrating a vitest file: rename `.test.ts` → `.bun.test.ts`, swap `from "vitest"` → `from "bun:test"`, replace `vi.fn` → `mock`, `vi.spyOn` → `spyOn`, `vi.mock` → `mock.module`, `vi.restoreAllMocks` → `mock.restore`. Run `bun test bun.test` to verify.

When a migrated file hits a gap, revert it (`mv foo.bun.test.ts foo.test.ts` and restore the vitest imports). Add a row to the table above so the next contributor knows why.

## 2. Every test gets a JSDoc header

Each `test(...)` block must carry a JSDoc with three tags so a reader can scan a file and understand intent without reading bodies. Enforced by convention; PR review rejects tests missing it.

```ts
/**
 * @case Single resolved tool produces one Vercel tool keyed by name
 * @preconditions Resolved tool with name "echo"; SDK execute called with input only
 * @expectedResult Returned map has key "echo"; handler receives the input as the first arg
 */
test("single resolved tool builds a Vercel tool that runs the handler", async () => {
  // ...
});
```

| Tag | Purpose |
|-----|---------|
| `@case` | What scenario the test covers, in user terms (one short sentence). |
| `@preconditions` | The setup that distinguishes this case from neighbours. |
| `@expectedResult` | The observable outcome the assertions check. |

The `test(...)` string itself is the searchable label. Keep it short and declarative; the JSDoc carries the explanation.

## 3. Test helpers from `@routecraft/testing`

| Helper | Use for |
|--------|---------|
| `testContext()` | Build an isolated `CraftContext` with plugins, routes, and stores. Returns a `TestContext` with `start()` / `stop()` lifecycle and an in-memory event log. Default for any test that touches routes or plugins. |
| `t.test()` | Run the routes once and wait for completion. Errors raised inside route handlers do not reject; inspect `t.errors` instead. |
| `t.startAndWaitReady()` | Start the context without running routes (e.g. to assert on side effects of plugin init or to interact via direct endpoints). |
| `spy()` | Spy destination that records every received exchange. Use as the terminal `.to()` when you want to assert on what reached it. |
| `pseudo()` | Configurable adapter that you fully control (source, destination, both). Use when no real adapter fits the test scenario. |
| `mockAdapter()` + `testContext().override()` | Replace a real adapter with a mock for one test run. Use when you need to assert on adapter-level interactions without standing up the real implementation. |
| `testFn(spec, input)` | Exercise a fn-shaped spec (`{ schema, handler }`) directly. Validates input, builds a synthetic `FnHandlerContext`, and calls the handler. Use for unit-testing fns registered via `agentPlugin({ functions: { ... } })` without touching the agent loop. |
| `fixture(path)` | Load a JSON fixture file. `fixtureEach(path, run)` runs one `test()` per array entry, using `entry.name` as the test name. |
| `createSpyLogger()` / `createNoopSpyLogger()` | Capture or silence log output. Pass into `testContext({ spyLogger })` to assert on log calls (e.g. that a warn was emitted). |

## 4. Lifecycle pattern

```ts
let t: TestContext | undefined;

afterEach(async () => {
  if (t) await t.stop();
  t = undefined;
});

test("...", async () => {
  t = await testContext().with({ ... }).routes(...).build();
  await t.test();
  expect(t.errors).toHaveLength(0);
});
```

Rules:

- Always assign to a single `let t` declared in the `describe` scope; the `afterEach` then handles teardown unconditionally.
- Always `await t.stop()`; not awaiting leaks timers, http servers, and background tasks across tests.
- Prefer `t.test()` over `t.startAndWaitReady()` when you want the routes to actually run. Use `startAndWaitReady` for tests that drive interaction through direct endpoints or that assert on plugin-init side effects.

## 5. Asserting on `RoutecraftError`

Prefer structural matchers over regex. Routecraft errors carry stable `rc` codes; assert on those.

```ts
expect(rcError).toMatchObject({ rc: "RC5003" });
// or
expect(isRoutecraftError(err)).toBe(true);
expect((err as RoutecraftError).rc).toBe("RC5003");
```

When asserting on the error message, use a tight regex anchored to the actionable phrase, not the full sentence (which is more likely to be reworded).

```ts
expect(t.errors[0]?.message).toMatch(/no "model"/i);
```

Avoid full string equality on error messages; the wording is not part of the API and small changes will churn tests.

## 6. Asserting on dispatch errors

Errors thrown inside route handlers are caught by the runtime, logged at the boundary, and surfaced on `TestContext.errors` rather than rejecting `t.test()`. The pattern is:

```ts
await t.test();
expect(t.errors[0]?.message).toMatch(/.../);
```

Errors thrown at construction (e.g. `validateAgentOptions` running inside `agent({...})`) DO reject the `await ... .build()` call. Use `await expect(builder).rejects.toThrow(...)` for those.

## 7. Negative-path logging is expected

Tests that exercise an error path through the framework boundary will produce error-level log output. This is deliberate: the framework's own logger ran. Do not treat such output as a test failure or filter it from CI logs. If a test produces noisy output but passes, leave it: the noise is the framework working as designed.

## 8. Snapshots

Avoid snapshot tests as a default. They make refactors painful and tend to be rubber-stamped on update. Use them only when:

- The output is large but structurally stable (e.g. generated TypeScript types).
- The assertion would otherwise require dozens of brittle `expect(...).toEqual(...)` lines that would all need to change together.

If you reach for a snapshot, prefer inline (`toMatchInlineSnapshot()`) over a separate `__snapshots__` file so the expected value lives next to the test.

## 9. Mocking guidance

- **Mock at the boundary.** Mock `vi.mock("../src/llm/providers/index.ts")` to stub `callLlm` rather than mocking the Vercel AI SDK; the boundary is more stable than the dependency's API.
- **Mock the SDK only when testing the boundary itself.** E.g. `stream-llm.test.ts` mocks `ai`'s `streamText` to exercise the real `streamLlm` containment behaviour.
- **Mirror real behaviour in mocks.** If the real code catches listener errors, the mock should too; otherwise the test passes for the wrong reason.

## 10. Cross-runtime adapter tests

Some adapters have runtime-specific code paths -- for example, a Postgres source might use `Bun.sql` under Bun and the `pg` driver under Node, or an S3 destination might use `Bun.s3` under Bun and `@aws-sdk/client-s3` under Node. The cross-runtime test suite verifies that the observable behaviour is identical on both runtimes.

**Layout.** Place these tests at `packages/<pkg>/test/cross-runtime/*.test.ts`. The default `bun run test` and `bun run test:coverage` scripts exclude this directory; only the dedicated `adapter-cross-runtime` CI job picks them up.

**Local execution.** From the repo root:

```sh
bun run test:cross-runtime
```

This runs vitest under Bun against the cross-runtime suite. To verify under Node:

```sh
npm run test:cross-runtime:node
```

The `:node` script resolves to `node node_modules/vitest/vitest.mjs run --passWithNoTests test/cross-runtime/` -- one canonical invocation referenced by both the workflow and these docs. CI runs both invocations as separate jobs (`adapter-cross-runtime (bun)` and `adapter-cross-runtime (node)`).

**When to add one.** New adapters with a Bun-vs-Node driver split, or library code that touches runtime-specific APIs (`Bun.file`, `bun:sqlite` direct usage, `worker_threads`, etc.). For pure type-only code or code that uses the same driver under both runtimes, the regular unit tests are sufficient.

**Reference.** No live cross-runtime tests exist today. The directory and CI matrix are in place for the upcoming Postgres ([#294](https://github.com/routecraftjs/routecraft/issues/294)) and S3 ([#295](https://github.com/routecraftjs/routecraft/issues/295)) adapters, which will land the first real entries (`Bun.sql` vs `pg`, `Bun.s3` vs `@aws-sdk/client-s3`). Until then both `adapter-cross-runtime` legs run with `--passWithNoTests`.

## 11. What runs in CI

- The main `test` job runs `bun run test:coverage` (which excludes `**/integration.test.ts` and `**/test/cross-runtime/**`, and uploads a `coverage-report` artifact). Locally, `bun run test` runs the same exclusions without the coverage instrumentation.
- `scaffolder-smoke` runs `bun run test:integration` twice -- once with `TEST_PACKAGE_MANAGER=bun` (full scaffold + `craft run` dispatch) and once with `TEST_PACKAGE_MANAGER=npm` (install + typecheck only; the dispatch test skips because the CLI is Bun-only).
- `embedding-smoke` runs `node .github/scripts/smoke-test-embedding.mjs` to verify the Node embedding path, including a negative arm asserting `RC5017` fires when `cron()` is used without `croner` installed.
- `adapter-cross-runtime (bun)` and `adapter-cross-runtime (node)` run the cross-runtime suite under each runtime; both arms must pass for a PR to be mergeable.
- See [CI/CD](./ci-cd.md) for the full job graph.

---

## References

- Test helpers source: `packages/testing/src/`
- Vitest config: `vitest.config.ts` at the workspace root
- CI workflow: `.github/workflows/ci.yml`
- Definition of Done: `DEFINITION_OF_DONE.md`
