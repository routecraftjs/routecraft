# Testing

Authoritative rules and conventions for tests in Routecraft.

---

## 1. Runner and layout

- **Runner:** Vitest. Same config across packages; the workspace `vitest --run` is the source of truth (root `package.json` script `test`).
- **File placement:** colocated with the package they exercise.
  - Unit tests: `packages/<name>/test/*.test.ts`.
  - Integration tests (real network, real subprocesses, slow setup): `packages/<name>/test/*.integration.test.ts` and run via `pnpm test:integration`. The default `pnpm test` excludes them.
- **One feature per file.** Group tests around the unit they exercise, not by category. A test file maps to a code file (or a closely related cluster), not to "all the validation tests in the package".

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

Tests that exercise an error path through the framework boundary will produce error-level log output. This is deliberate: the framework's own logger ran. Do not treat such output as a test failure or filter it from CI logs. If a test produces noisy output but passes, leave it — the noise is the framework working as designed.

## 8. Snapshots

Avoid snapshot tests as a default. They make refactors painful and tend to be rubber-stamped on update. Use them only when:

- The output is large but structurally stable (e.g. generated TypeScript types).
- The assertion would otherwise require dozens of brittle `expect(...).toEqual(...)` lines that would all need to change together.

If you reach for a snapshot, prefer inline (`toMatchInlineSnapshot()`) over a separate `__snapshots__` file so the expected value lives next to the test.

## 9. Mocking guidance

- **Mock at the boundary.** Mock `vi.mock("../src/llm/providers/index.ts")` to stub `callLlm` rather than mocking the Vercel AI SDK; the boundary is more stable than the dependency's API.
- **Mock the SDK only when testing the boundary itself.** E.g. `stream-llm.test.ts` mocks `ai`'s `streamText` to exercise the real `streamLlm` containment behaviour.
- **Mirror real behaviour in mocks.** If the real code catches listener errors, the mock should too — otherwise the test passes for the wrong reason.

## 10. What runs in CI

- `pnpm test` (excludes `*.integration.test.ts`) runs on the main `test` job.
- `pnpm test:integration` runs on the dedicated `integration-test` matrix (bun + npm) against published-shaped tarballs.
- Both must pass for a PR to be mergeable. See [CI/CD](./ci-cd.md).

---

## References

- Test helpers source: `packages/testing/src/`
- Vitest config: `vitest.config.ts` at the workspace root
- CI workflow: `.github/workflows/ci.yml`
- Definition of Done: `DEFINITION_OF_DONE.md`
