# CI/CD

What `.github/workflows/ci.yml` and `.github/workflows/release.yml` enforce and the policies contributors must know to work with them.

---

## 1. Job graph

```
  ci.yml (push + pull_request):

  changes  ─┬─►  validate ─┐
            │              ├─►  scaffolder-smoke
   setup ───┼─►  test  ────┤
            │              ├─►  embedding-smoke
            └─►  build ────┤
                           └─►  adapter-cross-runtime (bun + node)

  release.yml (workflow_run: CI succeeded on a main push):

  release (changesets: Version Packages PR  ─┬─►  publish-canary
           / stable publish + v* tag)        └─►  build-and-deploy-docs
```

Every ci.yml job that installs workspace dependencies restores bun's package cache (`~/.bun/install/cache`, key: `hashFiles('**/bun.lock')`) and then runs `bun install --frozen-lockfile`, which is seconds against a warm cache. `changes` installs nothing and `embedding-smoke` is deliberately node + npm (see the § 2 table), so neither restores it; release.yml's install steps are cold by design, since a publish is rare and correctness there outranks a minute. The linked `**/node_modules` tree is deliberately **not** cached: several dependencies ship a nested `node_modules` inside their own `dist` or test fixtures, nitro vendors `defu` there and imports it without declaring it, and a `**/node_modules` glob matches those nested trees separately from the tree containing them, so the archive carries overlapping paths and the restore silently drops files. Cache the packages, link them fresh. Build output is passed differently: `build` uploads `packages/*/dist` and `examples/dist` as a run artifact (`build-dist`) that the smoke and cross-runtime jobs download. Artifacts are guaranteed within the run that produced them, which a cache key is not. `changes` skips downstream jobs when the diff doesn't touch package or workflow paths.

The split between the two files is exact: **ci.yml validates and never publishes to npm; release.yml owns every npm publish** (stable releases AND canary snapshots). This is forced by npm Trusted Publishing, which allows one trusted publisher per package, pinned to a single workflow filename, so all publishes must originate from one file. release.yml triggers on `workflow_run` when CI completes successfully for a push to `main`, which also guarantees nothing is published from a commit whose tests or smokes failed. ci.yml's only involvement is uploading a `push-base` artifact (the push's `before` sha, unavailable in `workflow_run` payloads) that the canary job diffs against.

Docs deployment (`build-and-deploy-docs`) is the LAST job of release.yml, after the release job has pushed any fresh `v*` tag: the docs freeze always sees the version that was just released, a failed release attempt never moves the docs, and a release is self-contained end to end (publish, tag, canary, docs). Docs-only pushes still deploy on the main cadence because release.yml runs for every green main push; manual redeploys go through release.yml's `workflow_dispatch`, which runs only the docs job (never a publish).

## 2. The PR gates

Every PR must pass these jobs before merge. The first column matches the GitHub status check name shown in the PR.

| Job | Runs | Catches |
|-----|------|---------|
| `setup` | `bun install --frozen-lockfile` | Lockfile drift, install failures, dependabot lockfile updates. |
| `validate` | `bun run format && bun run typecheck && bun run lint && bunx madge --circular .` | Prettier drift, TS errors, ESLint violations, circular imports. |
| `test` | `bun run test:coverage` (runs `bun:test` for `*.bun.test.{ts,tsx}` then vitest for the rest, both excluding `**/integration.test.ts` and `**/test/cross-runtime/**`) | Unit-test regressions, coverage report uploaded as artifact. |
| `build` | `bun run build` and `bun run limit:size` | Build failures, bundle size regressions (size-limit). |
| `docs-site` | The site's own `typecheck` and `lint`, `check-examples`, a build, `check-links`, then the Playwright acceptance suite against that build | The site's checks are not in the root `validate` job, which typechecks the packages only. Catches broken app types, an example naming an option, symbol or literal that does not exist, dead internal links and anchors, and the URL space, channel, metadata and rendering contracts the migration was held to. `check-examples` runs before the build because it needs neither the build nor the browser. Runs on the `docs` paths filter in ci.yml: `apps/routecraft.dev/**`, `packages/**` (the reference catalogues are generated from them), `bun.lock` and `.github/workflows/**`. |
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

Docs-only PRs skip the smoke jobs. If you add a new code path that should gate on CI, add it to the filter.

### 3.4. PR trigger

CI runs on `pull_request`, so a PR's CI run uses the workflow definition from the PR's merge ref; workflow file changes in a PR take effect for that PR's own run.

## 4. Adding a new package (the checklist)

Packages are created by hand; there is no generator. Copy the shape of an existing package (`packages/ai` is the worked example for an ecosystem package that peers on core). CI, versioning, and publishing all discover packages automatically, so the checklist is short:

1. Create `packages/<name>/` with:
   - `package.json`: dual `exports` (`types`/`import`/`require` pointing at `dist/`), `"files": ["dist"]`, `"publishConfig": {"access": "public"}`, repository/homepage/bugs fields, scripts `build` (tsup), `test`, `prepublishOnly: "bun run build"`. Dependency shape per section 5.
   - `tsup.config.mjs` (or build script flags) with `external: ["@routecraft/routecraft"]` so core is never bundled.
   - `vitest.config.mjs` with aliases mapping `@routecraft/{routecraft,testing}` and the package's own name onto `src/` entry points (copy `packages/ai/vitest.config.mjs`). This serves the vitest arm only (cross-runtime suites and the deliberate exceptions in `testing.md` § 1); unit tests default to bun:test.
   - `src/index.ts` barrel. If the package contributes `defineConfig` keys or DSL, follow the cross-package pattern in `packages/ai/src/config.ts` (`declare module "@routecraft/routecraft"` + `registerConfigApplier` + side-effect import from the barrel).
   - Tests under `test/` per `.standards/testing.md` (JSDoc on every test).
2. Never add a `sideEffects` allowlist to a package that registers anything via side-effect imports (config appliers, DSL sugar, adapter registries). Core shipped this bug: its allowlist named only the dist entry points, so esbuild pruned every `registerConfigApplier` side-effect import out of the bundle and `defineConfig({ mail: {...} })` silently no-opped at runtime. Bundle-size wins must come from somewhere else. If the package relies on side-effect registration, add a post-build guard that imports the built bundles and asserts the registrations are live (core's `packages/routecraft/scripts/verify-dist.mjs`, run for both ESM and CJS in its `build` script, is the reference).
3. `bun install` (the root `workspaces` glob picks the directory up automatically; `bun run --filter '*' build`, `bun run test`, typecheck, and `changeset publish` all walk the workspace).
4. Add a size-limit entry in the root config if the package ships to users.
5. Add a docs page under `apps/routecraft.dev/app/content/docs/` and a row to the CLAUDE.md package table.
6. Add an introducing changeset: `bunx changeset` (minor, "Introduce @routecraft/<name>"). Decide whether the package joins the fixed core train in `.changeset/config.json` or versions independently (default: independently).

Nothing needs registering in workflows: there are no per-package publish loops or version scripts anymore.

## 5. Dependency policy on `@routecraft/*`

Publishable manifests never use the `workspace:` protocol. An ecosystem package that builds on core declares:

```jsonc
"peerDependencies": {
  "@routecraft/routecraft": ">=0.7.0-0 <1.0.0"   // published contract: real semver range
},
"devDependencies": {
  "@routecraft/routecraft": "workspace:*"  // local dev: always the in-tree copy
}
```

Why this shape:

- The `peerDependencies` range is what users see after publish. Bundling or hard-depending on core would cause duplicate-instance bugs (two `RoutecraftError` classes, two adapter registries); the peer forces a single instance, and the real range documents compatibility.
- The range form is version-era specific. Pre-1.0 it must be `>=<current minor>.0-0 <1.0.0`: in 0.x semver, `^0.7.0` excludes 0.8.0, so every core minor would leave the range and changesets major-bumps peer dependents whose range is left (`onlyUpdatePeerDependentsWhenOutOfRange` controls WHEN that cascade fires, not its size). At v1, tighten to `^1.0.0`; minors then stay in range and the cascade only fires on real majors.
- **The `-0` suffix is load-bearing, and the lower bound names the version the NEXT release will publish rather than the last one.** A prerelease satisfies a range only when some comparator carries a prerelease on the same `major.minor.patch`, and the suffix reaches no further than that one version. Executed:

```
>=0.7.0 <1.0.0     satisfies 0.7.0-canary-20260830132156   false
>=0.6.0-0 <1.0.0   satisfies 0.7.0-canary-20260830132156   false
>=0.7.0-0 <1.0.0   satisfies 0.7.0-canary-20260830132156   true
>=0.7.0-0 <1.0.0   satisfies 0.7.1-canary-20260901120000   false
>=0.7.0-0 <1.0.0   satisfies 0.8.0-canary-1                false
```

  A range that refuses the version being published is rewritten by changesets to that exact snapshot version, which is only coherent inside the batch that produced it, so `ai` and `os` (which publish in their own batches, per the pipeline table in section 9) end up pinned to a core canary that has already moved.

  The last two rows are the maintenance cost, and it is **one edit per released version, not per minor**: once 0.7.0 ships, `>=0.7.0-0` refuses the canaries of 0.7.1 just as it refuses 0.8.0's. The edit belongs to the change that proposes the next version, because that is the first moment the right bound is known: a tree with no pending changeset has no proposed next version, and no bound can be chosen for one.

  `packages/routecraft/test/core-version-range-contract.bun.test.ts` is the gate. It asserts the canary form only while a changeset actually proposes a release, so it fails the change that moves the line and never the "Version Packages" PR, and it names the manifest, the declared range and the version refused.

  This is a chore, and the durable fix is to have the canary job rewrite the ranges for the snapshot it is about to publish rather than have contributors keep the committed ranges ahead of the line; that is tracked separately.
- The `devDependencies` `workspace:*` keeps local development synced: Bun resolves it to the in-tree package, so editing core is immediately visible. `workspace:*` (not `workspace:^x.y.z`) so version bumps never touch devDependencies.
- The CLI is the one exception: it keeps core in `dependencies` with a plain `^` range on the LAST RELEASED version (`^0.6.0` while 0.6.0 is out), because `craft` needs core at runtime and users install the CLI standalone. A regular dependency is a different contract from a peer in both directions. Changesets rewrites it on every release rather than only when it leaves the range (`updateInternalDependencies` is `patch`), so it never reaches npm stale and never needs the `-0` a peer needs. And `bun install` resolves it against the workspace, so a range that names the NEXT version instead (`^0.7.0-0` against a 0.6.0 workspace) stops matching the in-tree core and silently links a published canary into `packages/cli/node_modules` instead. Leave it naming the released line; the release moves it.

The range itself is enforced by `packages/routecraft/test/core-version-range-contract.bun.test.ts`; the rest of the shape is enforced by review. When adding a new internal package that other packages depend on, mirror this pattern.

## 6. Optional peer dependencies (provider SDKs)

External SDKs that a package only needs when a specific feature is used (Vercel AI SDK adapters, `@huggingface/transformers`, `@modelcontextprotocol/server`, `croner`, `cheerio`, etc.) live in `peerDependencies` AND `peerDependenciesMeta.<name>.optional = true`. The adapter dynamically imports them via `loadOptionalPeer` (`packages/routecraft/src/adapters/shared/optional-peer.ts`) and throws **`RC5017`** with an install hint when the import fails. Don't add such deps to `dependencies`; that bloats every install.

**`loadOptionalPeer` is not adapter-only: `shared/sqlite/driver.ts` calls it on behalf of the suspension store and the telemetry SQLite sink, and neither is an adapter. A new SQLite consumer goes through that shared driver rather than calling `loadOptionalPeer` itself. Pass `consumer` (who is asking, used verbatim in the RC5017 message, so it carries its own noun: `"cron adapter"`, `"suspension store (sqlite)"`) and `packageName`. New code MUST use `loadOptionalPeer`.** The cron source (`packages/routecraft/src/adapters/cron/source.ts`) and the html adapter (`packages/routecraft/src/adapters/html/shared.ts`) are the canonical references; copy the shape (lazy import via the thunk, RC5017 message, type-only `import type` at the top of the file).

The pre-existing migration backlog tracked in [#287](https://github.com/routecraftjs/routecraft/issues/287) is closed: every dynamic-import optional-peer site now goes through `loadOptionalPeer`. `loadOptionalPeer` is exported from `@routecraft/routecraft` so cross-package adapters (`@routecraft/ai`'s mcp suite, `@routecraft/cli`) reuse the same helper. New code MUST follow the same shape and is reviewed against this contract. A repo-wide contract test (`packages/routecraft/test/optional-peer-contract.bun.test.ts`) enforces it across core, ai, os, and cli: any bare dynamic import of an optional peer fails the suite (regular dependencies and required peers are exempt).

## 7. Bun command conventions

- Use `bun run <script>` for any `package.json` script (root or workspace). E.g. `bun run lint`, `bun run --filter routecraft.dev dev`.
- Use `bunx <bin>` for one-shot binary execution from a `node_modules/.bin` entry. E.g. `bunx madge --circular .`, `bunx create-routecraft`.
- Don't mix conventions in the same doc or script. If you find an inconsistency, fix it and call it out in the PR description.

## 8. Local pre-PR checklist

The user-facing copy of this checklist lives in the contribution guide (`apps/routecraft.dev/app/content/docs/community/contribution-guide/index.mdx`); keep the two in sync.

Run before opening a PR; matches what CI runs:

```sh
bun run format     # prettier --check
bun run typecheck  # tsc --noEmit
bun run lint       # eslint
bun run test       # unit tests
bun run build      # all packages
```

Or the bundled `bun run all`, which runs `lint --fix`, `format:write`, `typecheck`, `build`, `test` in one pass.

Touching the docs site adds one more, run from `apps/routecraft.dev`:

```sh
bun run check:examples  # compiles the docs' TypeScript examples
```

It is not in `bun run all`, because it needs the site's own dependencies and
`all` is the packages' gate. A fenced `ts` block must compile, or its fence must
say why it cannot:

````
```ts skip="fragment: dest is illustrative"
```ts expect-error="json() takes path, not file"
````

Both markers need a non-empty reason, and both are audited: a `skip` on a block
that does compile fails the build, so a marker cannot be carried through a
rewrite and quietly leave the block unchecked.

Integration tests require a tarball + global CLI install and aren't expected to run locally for every PR. CI covers that path.

## 9. Release flow (changesets)

Versioning and publishing are owned by [changesets](https://github.com/changesets/changesets); model: vercel/ai. Never hand-edit `package.json` versions.

The core invariant: **`package.json` always holds the LAST RELEASED version**, never the upcoming one. Pending changesets describe what the next release will contain, and the auto-maintained "Version Packages" PR is the release gate: nothing stable ships until a human merges it. Canaries are calculated previews of that upcoming release (pending changesets included), so the canary channel always shows where the next stable will land.

### Contributor side

Every PR with a user-facing change adds a changeset: run `bunx changeset`, pick the affected package(s) and bump level, describe the change. Internal-only changes skip it (or use `bunx changeset add --empty` if a status check demands one).

**Bump levels during v0: breaking changes are `minor`, never `major`.** The whole 0.x line is the breaking window (see `api-stability.md`), so a conventional-commit `!` does NOT translate to a `major` changeset. A `major` bump would compute the next version as 1.0.0 and stamp every canary `1.0.0-canary-*` (this happened: a stray `major` computed 1.0.0 and shipped `1.0.0-canary-*` releases that had to be unpublished and deprecated). `major` is reserved for the deliberate 1.0.0 release and requires explicit maintainer sign-off in the PR.

### Versioning model

- `.changeset/config.json` declares a `fixed` group, the **core train**: `@routecraft/routecraft`, `@routecraft/cli`, `@routecraft/testing`, `create-routecraft`, `@routecraft/eslint-plugin-routecraft`, `@routecraft/prettier-plugin-routecraft`, and `routecraft.dev`. These always share one version number.
- `routecraft.dev` rides the train PASSIVELY: it is private (never published; `privatePackages` versions it and publish skips it) and sits in the group only so its manifest version tracks releases, because the docs site reads it as a fallback version source at runtime. Never name `routecraft.dev` in a changeset: a changeset naming any fixed-group member bumps the whole train, so a docs-site changeset would force an empty release of every core package. Docs-site changes ship on the main cadence with no changeset at all. (`fixed` is the only changesets mechanism that moves a changeset-less member with the train; the app has no `@routecraft/*` dependency edge, so plain versioning would never move it.)
- Everything else (`@routecraft/ai`, `@routecraft/os`, future vendor packages) versions independently.
- `examples` is under `ignore`, so changesets neither versions nor publishes it. Its version is hand-set in its own `package.json` and never moves with a release, which is the point: it stands in for a user's own project, and `craft.config.ts` reads that version as what its MCP server advertises. Note that this is a different arrangement from the bullet above: those packages are versioned independently BY changesets, while `examples` is versioned by hand.
- `onlyUpdatePeerDependentsWhenOutOfRange` is on, so a core bump that stays inside ecosystem peer ranges does not cascade at all. When a bump DOES leave the range, changesets major-bumps the dependents, which is why the pre-1.0 peer range form is `>=<current minor>.0-0 <1.0.0` (see section 5). The flag lives under changesets' `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH` key, so re-check the changesets release notes for it whenever bumping `@changesets/cli`.

### Pipeline

All rows below run inside `release.yml`, which triggers via `workflow_run` after CI completes successfully for a push to `main` (a red CI run publishes nothing).

| Trigger | Job | Result |
|---------|-----|--------|
| Main push with pending changesets | `release` (changesets action) | Opens/updates the "Version Packages" PR: runs `bun run version-packages` (= `changeset version` + `scripts/sync-derived-versions.mjs`, which patches the `.claude-plugin/{plugin,marketplace}.json` versions from core, + `scripts/finalise-changelog.mjs`, which rewrites the changelog's in-development heading to its released form). The branch is force-pushed on every regeneration, so never hand-commit to it; anything that must appear in the Version Packages PR belongs in the `version-packages` script. |
| Merging the "Version Packages" PR | `release` | `bun run release` (= build + `changeset publish`) publishes to npm with provenance, creates one GitHub Release per package version (tags like `@routecraft/routecraft@0.7.0`), and pushes a `v<core-version>` tag; `build-and-deploy-docs` then freezes the docs to that fresh tag in the same workflow run. |
| Main push touching packages | `publish-canary` (after `release`) | Publishes canaries of the packages CHANGED by the push (`0.6.0-canary-<datetime>`, calculated from the last release plus pending changesets) under the npm `canary` dist-tag, no git tags. A synthetic changeset is generated from the git diff (base sha handed over from CI as the `push-base` artifact), so canaries flow on every merge whether or not the PR carried a changeset. The fixed core train always moves together (a change to any train member canaries the whole train, lockstep); independent packages (ai, os) canary when they themselves changed OR while they carry a pending changeset (the canary previews the whole upcoming release). |

npm auth is tokenless: **Trusted Publishing** (OIDC) is configured on npmjs.com per package, and `npm publish` picks it up via the job's `id-token: write` permission (requires npm >= 11.5; Node 24 from `.nvmrc` bundles it). Provenance is generated automatically. Two operational notes:

- npm allows **one trusted publisher per package**, pinned to a single workflow filename. Every package's trusted publisher must be `release.yml` (this repo). This constraint is WHY all publishing lives in release.yml; never add an npm publish step to ci.yml or any other workflow.
- A brand-new package cannot authenticate this way for its FIRST publish (npm requires the package to exist before a trusted publisher can be configured). Publish a new package once with a granular token or manually from a maintainer machine, then set `release.yml` as its trusted publisher.

The CLI's `--version` needs no syncing: `packages/cli/src/index.ts` imports the version from its own package.json and tsup inlines it at build.

The publish goes through `changeset publish` (npm under the hood) even though the workspace is Bun, because npm publishing remains the canonical registry path and `prepublishOnly` hooks call `bun run build` to assemble dist.

---

## References

- Workflow sources: `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Scripts: `scripts/sync-derived-versions.mjs`, `scripts/finalise-changelog.mjs`, `scripts/prepare-canary-snapshot.mjs`, `.github/scripts/smoke-test-embedding.mjs`, `packages/routecraft/scripts/verify-dist.mjs`
- Changesets config: `.changeset/config.json`
- Definition of Done: `DEFINITION_OF_DONE.md`
- Testing standards: `./testing.md`
