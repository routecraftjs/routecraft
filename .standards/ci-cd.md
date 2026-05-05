# CI/CD

What `.github/workflows/ci.yml` enforces and the policies contributors must know to work with it.

---

## 1. Job graph

```
  changes  ─┬─►  validate ─┐
            │              │
   setup ───┼─►  test  ────┼─►  integration-test (bun + node)  ──►  approve  ──►  merge
            │              │                                          │
            └─►  build ────┘                                          └─►  publish-canary  ──►  publish  ──►  deploy-pages
```

The `setup` job runs `bun install --frozen-lockfile` and seeds the workspace's `**/node_modules`. Every downstream job restores that cache (key: `hashFiles('**/bun.lock')`), so the install only repeats on a cache miss. `changes` skips downstream jobs when the diff doesn't touch package or workflow paths.

## 2. The PR gates

Every PR must pass these jobs before merge. The first column matches the GitHub status check name shown in the PR.

| Job | Runs | Catches |
|-----|------|---------|
| `setup` | `bun install --frozen-lockfile` | Lockfile drift, install failures, dependabot lockfile updates. |
| `validate` | `bun run format && bun run typecheck && bun run lint && bunx madge --circular .` | Prettier drift, TS errors, ESLint violations, circular imports. |
| `test` | `bun run test:coverage` (excludes `**/integration.test.ts` and `**/test/cross-runtime/**`) | Unit-test regressions, coverage report uploaded as artifact. |
| `build` | `bun run build` and `bun run limit:size` | Build failures, bundle size regressions (size-limit). |
| `scaffolder-smoke` | `bun run test:integration` twice (`TEST_PACKAGE_MANAGER=bun`, then `=npm`) | End-to-end scaffolder flow: `create-routecraft` -> install -> `bunx tsc --noEmit` -> `bunx craft run` (npm arm skips the run since `craft` is Bun-only). Catches CLI binary regressions, scaffolder template drift, package-manager-specific install failures. |
| `embedding-smoke` | `node .github/scripts/smoke-test-embedding.mjs` | Library embeds into a plain Node app: `npm pack` + `npm install` + `node --experimental-strip-types runner.ts`. Includes a negative arm asserting `RC5017` fires when `cron()` is used without `croner` installed. Catches Node compatibility regressions in the core library and the optional-peer contract. |
| `adapter-cross-runtime (bun)` | `bun run test:cross-runtime` (matches `**/test/cross-runtime/**/*.test.ts`) | Adapter tests that must produce identical observable behaviour under Bun and Node. Bun arm runs the suite under Bun. |
| `adapter-cross-runtime (node)` | `npm run test:cross-runtime:node` (resolves to `node node_modules/vitest/vitest.mjs run --passWithNoTests test/cross-runtime/`) | Same suite as above, run under Node. New adapters with a runtime-specific code path (`Bun.sql` vs `pg`, `Bun.s3` vs `@aws-sdk/client-s3`, etc.) drop a sibling test in `packages/<pkg>/test/cross-runtime/*.test.ts` and both arms must pass. |
| `cubic · AI code reviewer` | External AI reviewer | Dual-use review signal; informational on PR but does not gate merge. |

The `validate` job is the cheapest signal: if it's red, fix that first. The `test` job uploads `coverage-report` as an artifact; reviewers can download to inspect uncovered lines.

## 3. Rules contributors must follow

### 3.1. Hooks must succeed; never `--no-verify`

Husky + lint-staged run `eslint --fix`, `prettier --write`, and `bun run typecheck` on every commit. If a hook fails, fix the underlying issue. Bypassing hooks (`--no-verify`, `--no-gpg-sign`) is forbidden unless the user explicitly asks for it. A hook failure is a green light to investigate, not a green light to skip.

### 3.2. New commits, never `--amend` after a hook failure

If a pre-commit hook fails, the commit didn't happen. `--amend` would modify the previous commit (which DID happen) and discard work. Re-stage and commit anew.

### 3.3. The `changes` filter governs whether package jobs run

`changes` checks paths against:

- `packages` filter: `packages/**`, `examples/**`, `bun.lock`, `tsconfig*.json`, `.github/workflows/**`, `.github/scripts/**`.
- `docs` filter: `apps/routecraft.dev/**`, `.github/workflows/**`.

Pure docs-only PRs skip `integration-test`, `publish-canary`, and `publish`. If you add a new code path that should gate on CI, add it to the relevant filter.

### 3.4. PR target trigger

CI uses `pull_request_target`, not `pull_request`. This gives forks access to repo secrets (needed for the `dependabot[bot]` lockfile-update path), but it also means the workflow runs from `main`'s definition with the PR's head checked out. **Workflow file changes in a PR do NOT take effect for that PR's CI run.** They take effect after merge.

## 4. Adding a new package to CI

The CI doesn't enumerate packages; `bun run --filter '*' build`, `bun run test`, etc. walk every workspace package. To make a new package CI-visible:

1. Add it to the root `package.json` `workspaces` array (it'll get picked up automatically).
2. Add `build`, `test` (if any tests exist), and ensure `tsc --noEmit` cleanliness from the workspace root.
3. If the package publishes (`"private": false`), add it to:
   - `.github/scripts/set-version.mjs` so the `version:set` script bumps it.
   - The release-restore step in `integration-test` (the `git checkout --` line that resets package.jsons after `set-version` modifies them).
   - The `for pkg in ...` loops in the `publish-canary` and `publish` jobs.
4. If it depends on another workspace package, follow the dual-spec convention (see 5).

## 5. Peer-dependency policy on `@routecraft/*`

Every `@routecraft/*` workspace package that's a peer of another carries TWO entries:

```jsonc
"devDependencies": {
  "@routecraft/routecraft": "workspace:^0.5.0"  // dev: pin to current version
},
"peerDependencies": {
  "@routecraft/routecraft": "*"                  // runtime: accept any version
}
```

Why both:

- The `devDependencies` `workspace:^0.5.0` keeps local development synced. Bun's `workspace:` protocol resolves to the in-tree package, so editing `@routecraft/routecraft` is immediately visible.
- The `peerDependencies` `*` is what users see after publish. Bundling the peer would cause duplicate-instance bugs (two `RoutecraftError` classes, two adapter registries). `*` lets the user pick the version and forces a single instance.

This is enforced informally by review. When adding a new internal package that other packages depend on, mirror this pattern.

## 6. Optional peer dependencies (provider SDKs)

External SDKs that a package only needs when a specific feature is used (Vercel AI SDK adapters, `@huggingface/transformers`, `@modelcontextprotocol/sdk`, `croner`, `cheerio`, etc.) live in `peerDependencies` AND `peerDependenciesMeta.<name>.optional = true`. The adapter dynamically imports them via `loadOptionalPeer` (`packages/routecraft/src/adapters/shared/optional-peer.ts`) and throws **`RC5017`** with an install hint when the import fails. Don't add such deps to `dependencies`; that bloats every install.

**New code MUST use `loadOptionalPeer`.** The cron source (`packages/routecraft/src/adapters/cron/source.ts`) and the html adapter (`packages/routecraft/src/adapters/html/shared.ts`) are the canonical references; copy the shape (lazy import via the thunk, RC5017 message, type-only `import type` at the top of the file).

A pre-existing migration backlog of bespoke try/catch sites in `packages/ai/src/mcp/*`, `packages/routecraft/src/auth/jwks.ts`, `packages/routecraft/src/telemetry/plugin.ts`, `packages/routecraft/src/adapters/mail/strict-verify.ts`, and `packages/cli/src/tui/db.ts` is tracked in [#287](https://github.com/routecraftjs/routecraft/issues/287). When touching one of those files for an unrelated reason, opportunistically migrate it as part of the PR. They surface inconsistent error shapes today (some `Error`, one `RC5003`, none `RC5017`); the migration normalises them.

## 7. Bun command conventions

- Use `bun run <script>` for any `package.json` script (root or workspace). E.g. `bun run lint`, `bun run --filter routecraft.dev dev`.
- Use `bunx <bin>` for one-shot binary execution from a `node_modules/.bin` entry. E.g. `bunx madge --circular .`, `bunx create-routecraft`.
- Don't mix conventions in the same doc or script. If you find an inconsistency, fix it and call it out in the PR description.

## 8. Local pre-PR checklist

Run before opening a PR; matches what CI runs:

```sh
bun run format     # prettier --check
bun run typecheck  # tsc --noEmit
bun run lint       # eslint
bun run test       # unit tests
bun run build      # all packages
```

Or the bundled `bun run all`, which runs `lint --fix`, `format:write`, `typecheck`, `build`, `test` in one pass.

Integration tests require a tarball + global CLI install and aren't expected to run locally for every PR. CI covers that path.

## 9. Release flow

| Trigger | Result |
|---------|--------|
| Push to `main` | Runs CI; on success runs `publish-canary` which publishes a `0.5.0-canary.<sha>` tag for every workspace package. |
| GitHub release created | Runs CI; on success the `approve` + `merge` + `publish` chain publishes the tagged version to npm and `deploy-pages` deploys the docs site. |
| `workflow_dispatch` (manual) | Runs CI without publish steps (useful for sanity-checking a PR-target run). |

Versions are uniformly bumped via `bun run version:set <version>` (see `.github/scripts/set-version.mjs`), which patches every `package.json`, the CLI's `--version` constant, and the docs site's version selector. Don't hand-edit individual `package.json` versions.

The publish step (`npm publish` per package) is package-manager-agnostic. It uses npm even though the workspace is Bun, because npm publishing remains the canonical registry path and `prepublishOnly` hooks call `bun run build` to assemble dist.

---

## References

- Workflow source: `.github/workflows/ci.yml`
- Scripts: `.github/scripts/set-version.mjs`, `.github/scripts/smoke-test-embedding.mjs`
- Definition of Done: `DEFINITION_OF_DONE.md`
- Testing standards: `./testing.md`
