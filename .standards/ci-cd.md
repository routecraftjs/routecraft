# CI/CD

What `.github/workflows/ci.yml` and `.github/workflows/release.yml` enforce and the policies contributors must know to work with them.

---

## 1. Job graph

```
  changes  ─┬─►  validate ─┐
            │              ├─►  scaffolder-smoke ─────────┬─►  publish-snapshot
   setup ───┼─►  test  ────┤                              │      (canary)
            │              ├─►  embedding-smoke ──────────┤
            └─►  build ────┤                              │
                           └─►  adapter-cross-runtime  ───┴─►  build-and-deploy-docs
                                  (bun + node)
```

The `setup` job runs `bun install --frozen-lockfile` and seeds the workspace's `**/node_modules`. Downstream jobs restore that cache (key: `hashFiles('**/bun.lock')`) and reinstall on a miss; the GitHub cache service is best-effort, so a miss must never fail a job. Build output is passed differently: `build` uploads `packages/*/dist` and `examples/dist` as a run artifact (`build-dist`) that the smoke and cross-runtime jobs download. Artifacts are guaranteed within the run that produced them, which a cache key is not. `changes` skips downstream jobs when the diff doesn't touch package or workflow paths.

Real releases do not live in ci.yml: `release.yml` runs the changesets action on every push to `main` (see section 9). ci.yml's `publish-snapshot` only ships throwaway canary builds.

Docs deployment (`build-and-deploy-docs`) is gated on the same integration-test trio as `publish-snapshot`, so we never ship docs from a build that failed integration. On docs-only pushes the integration jobs are skipped and the deploy proceeds (`if: !cancelled() && !failure()`).

## 2. The PR gates

Every PR must pass these jobs before merge. The first column matches the GitHub status check name shown in the PR.

| Job | Runs | Catches |
|-----|------|---------|
| `setup` | `bun install --frozen-lockfile` | Lockfile drift, install failures, dependabot lockfile updates. |
| `validate` | `bun run format && bun run typecheck && bun run lint && bunx madge --circular .` | Prettier drift, TS errors, ESLint violations, circular imports. |
| `test` | `bun run test:coverage` (runs `bun:test` for `*.bun.test.{ts,tsx}` then vitest for the rest, both excluding `**/integration.test.ts` and `**/test/cross-runtime/**`) | Unit-test regressions, coverage report uploaded as artifact. |
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

`changes` checks paths against the `packages` filter: `packages/**`, `examples/**`, `bun.lock`, `tsconfig*.json`, `.github/workflows/**`, `.github/scripts/**`, `.changeset/**`.

Docs-only PRs skip the smoke jobs and `publish-snapshot`. If you add a new code path that should gate on CI, add it to the filter.

### 3.4. PR trigger

CI runs on `pull_request`, so a PR's CI run uses the workflow definition from the PR's merge ref; workflow file changes in a PR take effect for that PR's own run.

## 4. Adding a new package (the checklist)

Packages are created by hand; there is no generator. Copy the shape of an existing package (`packages/ai` is the worked example for an ecosystem package that peers on core). CI, versioning, and publishing all discover packages automatically, so the checklist is short:

1. Create `packages/<name>/` with:
   - `package.json`: dual `exports` (`types`/`import`/`require` pointing at `dist/`), `"files": ["dist"]`, `"publishConfig": {"access": "public"}`, repository/homepage/bugs fields, scripts `build` (tsup), `test`, `prepublishOnly: "bun run build"`. Dependency shape per section 5.
   - `tsup.config.mjs` (or build script flags) with `external: ["@routecraft/routecraft"]` so core is never bundled.
   - `vitest.config.mjs` with aliases mapping `@routecraft/{routecraft,testing}` and the package's own name onto `src/` entry points (copy `packages/ai/vitest.config.mjs`).
   - `src/index.ts` barrel. If the package contributes `defineConfig` keys or DSL, follow the cross-package pattern in `packages/ai/src/config.ts` (`declare module "@routecraft/routecraft"` + `registerConfigApplier` + side-effect import from the barrel).
   - Tests under `test/` per `.standards/testing.md` (JSDoc on every test).
2. `bun install` (the root `workspaces` glob picks the directory up automatically; `bun run --filter '*' build`, `bun run test`, typecheck, and `changeset publish` all walk the workspace).
3. Add a size-limit entry in the root config if the package ships to users.
4. Add a docs page under `apps/routecraft.dev/src/app/docs/` and a row to the CLAUDE.md package table.
5. Add an introducing changeset: `bunx changeset` (minor, "Introduce @routecraft/<name>"). Decide whether the package joins the fixed core train in `.changeset/config.json` or versions independently (default: independently).

Nothing needs registering in workflows: there are no per-package publish loops or version scripts anymore.

## 5. Dependency policy on `@routecraft/*`

Publishable manifests never use the `workspace:` protocol. An ecosystem package that builds on core declares:

```jsonc
"peerDependencies": {
  "@routecraft/routecraft": "^0.6.0"   // published contract: real semver range
},
"devDependencies": {
  "@routecraft/routecraft": "workspace:*"  // local dev: always the in-tree copy
}
```

Why this shape:

- The `peerDependencies` range is what users see after publish. Bundling or hard-depending on core would cause duplicate-instance bugs (two `RoutecraftError` classes, two adapter registries); the peer forces a single instance, and the real range documents compatibility. Changesets keeps the range current (`onlyUpdatePeerDependentsWhenOutOfRange` stops core minors from major-cascading through it).
- The `devDependencies` `workspace:*` keeps local development synced: Bun resolves it to the in-tree package, so editing core is immediately visible. `workspace:*` (not `workspace:^x.y.z`) so version bumps never touch devDependencies.
- The CLI is the one exception: it keeps core in `dependencies` with a plain `^` range, because `craft` needs core at runtime and users install the CLI standalone.

This is enforced informally by review. When adding a new internal package that other packages depend on, mirror this pattern.

## 6. Optional peer dependencies (provider SDKs)

External SDKs that a package only needs when a specific feature is used (Vercel AI SDK adapters, `@huggingface/transformers`, `@modelcontextprotocol/sdk`, `croner`, `cheerio`, etc.) live in `peerDependencies` AND `peerDependenciesMeta.<name>.optional = true`. The adapter dynamically imports them via `loadOptionalPeer` (`packages/routecraft/src/adapters/shared/optional-peer.ts`) and throws **`RC5017`** with an install hint when the import fails. Don't add such deps to `dependencies`; that bloats every install.

**New code MUST use `loadOptionalPeer`.** The cron source (`packages/routecraft/src/adapters/cron/source.ts`) and the html adapter (`packages/routecraft/src/adapters/html/shared.ts`) are the canonical references; copy the shape (lazy import via the thunk, RC5017 message, type-only `import type` at the top of the file).

The pre-existing migration backlog tracked in [#287](https://github.com/routecraftjs/routecraft/issues/287) is closed: every dynamic-import optional-peer site now goes through `loadOptionalPeer`. `loadOptionalPeer` is exported from `@routecraft/routecraft` so cross-package adapters (`@routecraft/ai`'s mcp suite, `@routecraft/cli`) reuse the same helper. New code MUST follow the same shape and is reviewed against this contract.

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

## 9. Release flow (changesets)

Versioning and publishing are owned by [changesets](https://github.com/changesets/changesets); model: vercel/ai. Never hand-edit `package.json` versions.

### Contributor side

Every PR with a user-facing change adds a changeset: run `bunx changeset`, pick the affected package(s) and bump level, describe the change. Internal-only changes skip it (or use `bunx changeset add --empty` if a status check demands one).

### Versioning model

- `.changeset/config.json` declares a `fixed` group, the **core train**: `@routecraft/routecraft`, `@routecraft/cli`, `@routecraft/testing`, `create-routecraft`, `@routecraft/eslint-plugin-routecraft`, `@routecraft/prettier-plugin-routecraft`. These always share one version number.
- Everything else (`@routecraft/ai`, `@routecraft/browser`, future vendor packages) versions independently.
- `routecraft.dev` and `examples` are ignored; `@routecraft/os` is versioned but never tagged/published (private).
- `onlyUpdatePeerDependentsWhenOutOfRange` is on, so a core minor does not major-cascade through ecosystem peer ranges. It lives under changesets' `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH` key, so re-check the changesets release notes for it whenever bumping `@changesets/cli`.

### Pipeline

| Trigger | Workflow | Result |
|---------|----------|--------|
| Push to `main` with pending changesets | `release.yml` (changesets action) | Opens/updates the "Version Packages" PR: runs `bun run version-packages` (= `changeset version` + `scripts/sync-derived-versions.mjs`, which patches the `.claude-plugin/{plugin,marketplace}.json` versions from core). |
| Merging the "Version Packages" PR | `release.yml` | `bun run release` (= build + `changeset publish`) publishes to npm with provenance, creates one GitHub Release per package version (tags like `@routecraft/routecraft@0.7.0`), pushes a `v<core-version>` tag (the docs freeze keys off `v*`), and re-dispatches CI so the docs deploy picks up the fresh tag. |
| Push to `main` touching packages (after smokes pass) | `ci.yml` `publish-snapshot` | Publishes canaries of the packages CHANGED by the push (`0.6.1-canary-<datetime>`) under the npm `canary` dist-tag, no git tags. A synthetic changeset is generated from the git diff, so canaries flow on every merge whether or not the PR carried a changeset. The fixed core train always moves together (a change to any train member canaries the whole train, lockstep); independent packages (ai, browser) only get a canary when they themselves changed, calculated from their own version line. |

npm auth is tokenless: **Trusted Publishing** (OIDC) is configured on npmjs.com per package, pinned to this repo and the publishing workflow file, and `npm publish` picks it up via the job's `id-token: write` permission (requires npm >= 11.5; Node 24 from `.nvmrc` bundles it). Provenance is generated automatically. Two operational notes:

- The trusted-publisher config is pinned to the workflow **filename**, so each published package must list BOTH `ci.yml` (snapshots) and `release.yml` (releases) on npmjs.com.
- A brand-new package cannot authenticate this way for its FIRST publish (npm requires the package to exist before a trusted publisher can be configured). Publish a new package once with a granular token or manually from a maintainer machine, then add its trusted publishers.

The CLI's `--version` needs no syncing: `packages/cli/src/index.ts` imports the version from its own package.json and tsup inlines it at build.

The publish goes through `changeset publish` (npm under the hood) even though the workspace is Bun, because npm publishing remains the canonical registry path and `prepublishOnly` hooks call `bun run build` to assemble dist.

---

## References

- Workflow sources: `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Scripts: `scripts/sync-derived-versions.mjs`, `.github/scripts/smoke-test-embedding.mjs`
- Changesets config: `.changeset/config.json`
- Definition of Done: `DEFINITION_OF_DONE.md`
- Testing standards: `./testing.md`
