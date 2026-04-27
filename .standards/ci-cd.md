# CI/CD

What `.github/workflows/ci.yml` enforces and the policies contributors must know to work with it.

---

## 1. Job graph

```
  changes  ─┬─►  validate ─┐
            │              │
   setup ───┼─►  test  ────┼─►  integration-test (npm + bun)  ──►  approve  ──►  merge
            │              │                                         │
            └─►  build ────┘                                         └─►  publish-canary  ──►  publish  ──►  deploy-pages
```

The `setup` job restores the pnpm cache. Every downstream job restores `**/node_modules` from the same cache key (`hashFiles('**/pnpm-lock.yaml')`), so `pnpm install` only runs on cache miss. `changes` skips downstream jobs when the diff doesn't touch package or workflow paths.

## 2. The PR gates

Every PR must pass these jobs before merge. The first column matches the GitHub status check name shown in the PR.

| Job | Runs | Catches |
|-----|------|---------|
| `setup` | `pnpm install --frozen-lockfile` | Lockfile drift, install failures, dependabot lockfile updates. |
| `validate` | `pnpm format && pnpm typecheck && pnpm lint && pnpm exec madge --circular .` | Prettier drift, TS errors, ESLint violations, circular imports. |
| `test` | `pnpm test:coverage` (excludes `**/integration.test.ts`) | Unit-test regressions, coverage report uploaded as artifact. |
| `build` | `pnpm run build` and `pnpm run limit:size` | Build failures, bundle size regressions (size-limit). |
| `integration-test (npm)` | Smoke-test publishable + `pnpm test:integration` against a packed tarball | Tarball install path, `craft` CLI binary publishability. |
| `integration-test (bun)` | `pnpm test:integration` under the Bun runtime | Bun runtime divergence in source / generated code. |
| `cubic · AI code reviewer` | External AI reviewer | Dual-use review signal; informational on PR but does not gate merge. |

The `validate` job is the cheapest signal: if it's red, fix that first. The `test` job uploads `coverage-report` as an artifact; reviewers can download to inspect uncovered lines.

## 3. Rules contributors must follow

### 3.1. Hooks must succeed; never `--no-verify`

Husky + lint-staged run `eslint --fix`, `prettier --write`, and `pnpm typecheck` on every commit. If a hook fails, fix the underlying issue. Bypassing hooks (`--no-verify`, `--no-gpg-sign`) is forbidden unless the user explicitly asks for it. A hook failure is a green light to investigate, not a green light to skip.

### 3.2. New commits, never `--amend` after a hook failure

If a pre-commit hook fails, the commit didn't happen. `--amend` would modify the previous commit (which DID happen) and discard work. Re-stage and commit anew.

### 3.3. The `changes` filter governs whether package jobs run

`changes` checks paths against:

- `packages` filter: `packages/**`, `examples/**`, `pnpm-lock.yaml`, `tsconfig*.json`, `.github/workflows/**`, `.github/scripts/**`.
- `docs` filter: `apps/routecraft.dev/**`, `.github/workflows/**`.

Pure docs-only PRs skip `integration-test`, `publish-canary`, and `publish`. If you add a new code path that should gate on CI, add it to the relevant filter.

### 3.4. PR target trigger

CI uses `pull_request_target`, not `pull_request`. This gives forks access to repo secrets (needed for the `dependabot[bot]` lockfile-update path), but it also means the workflow runs from `main`'s definition with the PR's head checked out. **Workflow file changes in a PR do NOT take effect for that PR's CI run.** They take effect after merge.

## 4. Adding a new package to CI

The CI doesn't enumerate packages; `pnpm -r run build`, `pnpm test`, etc. walk every workspace package. To make a new package CI-visible:

1. Add it to `pnpm-workspace.yaml` (it'll get picked up automatically).
2. Add `build`, `test` (if any tests exist), and ensure `tsc --noEmit` cleanliness from the workspace root.
3. If the package publishes (`"private": false`), add it to:
   - `.github/scripts/set-version.mjs` so the `version:set` script bumps it.
   - The release-restore step in `integration-test` (the `git checkout --` line that resets package.jsons after `set-version` modifies them).
   - `.github/scripts/smoke-test-publishable.mjs` if it should be exercised in the publish smoke test.
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

- The `devDependencies` `workspace:^0.5.0` keeps local development synced. pnpm's `workspace:` protocol resolves to the in-tree package, so editing `@routecraft/routecraft` is immediately visible.
- The `peerDependencies` `*` is what users see after publish. Bundling the peer would cause duplicate-instance bugs (two `RoutecraftError` classes, two adapter registries). `*` lets the user pick the version and forces a single instance.

This is enforced informally by review. When adding a new internal package that other packages depend on, mirror this pattern.

## 6. Optional peer dependencies (provider SDKs)

External SDKs that a package only needs when a specific feature is used (Vercel AI SDK adapters, `@huggingface/transformers`, `@modelcontextprotocol/sdk`, etc.) live in `peerDependencies` AND `peerDependenciesMeta.<name>.optional = true`. The framework dynamically imports them inside the relevant code path and throws a friendly install message when the import fails. Don't add such deps to `dependencies`; that bloats every install.

## 7. Local pre-PR checklist

Run before opening a PR; matches what CI runs:

```sh
pnpm format     # prettier --check
pnpm typecheck  # tsc --noEmit
pnpm lint       # eslint
pnpm test       # unit tests
pnpm build      # all packages
```

Or the bundled `pnpm all`, which runs `lint --fix`, `format:write`, `typecheck`, `build`, `test` in one pass.

Integration tests require a tarball + global CLI install and aren't expected to run locally for every PR. CI covers that path.

## 8. Release flow

| Trigger | Result |
|---------|--------|
| Push to `main` | Runs CI; on success runs `publish-canary` which publishes a `0.5.0-canary.<sha>` tag for every workspace package. |
| GitHub release created | Runs CI; on success the `approve` + `merge` + `publish` chain publishes the tagged version to npm and `deploy-pages` deploys the docs site. |
| `workflow_dispatch` (manual) | Runs CI without publish steps (useful for sanity-checking a PR-target run). |

Versions are uniformly bumped via `pnpm run version:set <version>` (see `.github/scripts/set-version.mjs`), which patches every `package.json`, the CLI's `--version` constant, and the docs site's version selector. Don't hand-edit individual `package.json` versions.

---

## References

- Workflow source: `.github/workflows/ci.yml`
- Scripts: `.github/scripts/set-version.mjs`, `.github/scripts/smoke-test-publishable.mjs`
- Definition of Done: `DEFINITION_OF_DONE.md`
- Testing standards: `./testing.md`
