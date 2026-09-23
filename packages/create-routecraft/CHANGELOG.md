# create-routecraft

## 0.7.0

### Minor Changes

- [#787](https://github.com/routecraftjs/routecraft/pull/787) [`5dcc38a`](https://github.com/routecraftjs/routecraft/commit/5dcc38a7d0e0216158c261395c983491543cb79d) Thanks [@claude](https://github.com/apps/claude)! - One template, laid out for `craft start`, and CI runs the scaffold's own tests ([#776](https://github.com/routecraftjs/routecraft/issues/776)).

  `bunx create-routecraft my-app` now always scaffolds the same project: a sample capability under `capabilities/`, a README naming what was made, and `start` wired to `craft start`. The `none` / `hello-world` choice is gone, and with it `index.ts`, `index-empty.ts`, `index-with-example.ts`, `templates/examples/` and the per-example `deps.json`.

  **The default used to be an empty project.** `--yes` and the first entry of the prompt both resolved to `none`, which wrote `export default []` and then printed `bun run start` as the next step. That command booted a context with zero routes and exited. A new user's first command produced nothing, and there was no README to say what to do instead.

  **It also taught the pre-0.7 model.** `start` was `craft --log-level info run index.ts` with routes wired by hand, while the example already sat at `capabilities/hello-world/route.ts`, which `craft start` discovers on its own. The template contradicted the project-structure docs and craft-harness both.

  ```
  before (--yes)            after
    index.ts                  capabilities/hello-world/route.ts
    craft.config.ts           capabilities/hello-world/route.bun.test.ts
    package.json              capabilities/hello-world/README.md
    ...                       craft.config.ts
                              README.md
    start: craft --log-level info run index.ts
                              package.json
                              ...
                            start: craft start
  ```

  **The scaffolded test failed, and CI could not see it.** The template's own `route.bun.test.ts` asserted `expect(t.logger.info).toHaveBeenCalled()` against `testContext()`, whose spy is runner-agnostic rather than a `bun:test` mock, so `bun run test` failed on a freshly scaffolded project. It shipped because the integration suite only ever installed and type-checked a scaffold. It now runs the scaffold's own test script, which is the gate that would have caught it.

  **`--example <url>` replaces the template rather than adding to it.** A repository is a whole project, so the sample capability and the project README are not written at all when one is given. Previously the sample capability did not exist to collide; now it would have been left standing inside somebody else's harness.

  `adapters/` and `plugins/` are no longer created. Git cannot carry an empty directory, so they vanished on the author's first commit; the README names the convention instead.

  **Also fixed:** `processTemplate` replaces the longest placeholder first. `PACKAGE_MANAGER` is a prefix of `PACKAGE_MANAGER_RUN`, and object key order decided which won, leaving `bun@1.3.9_RUN` in the output. It throws nowhere and is only ever noticed by a reader.

- [#699](https://github.com/routecraftjs/routecraft/pull/699) [`3f64e8c`](https://github.com/routecraftjs/routecraft/commit/3f64e8c71452b0b4357a920ab2f4073d15e1f9f0) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Scaffolding from a repository keeps the files it copies, and deferred agent threads can be rewritten in place.

  **The scaffolder no longer loses files ([#653](https://github.com/routecraftjs/routecraft/issues/653)).** A built-in example copied with `force: false` and no `errorOnExist`, so an example file landing where the base template already wrote one vanished with nothing in the output to say so. The collisions are now walked before the copy and named afterwards.

  **A URL example's `package.json` is merged, not overwritten.** It used to replace the base manifest outright, which threw away the project name the user had just typed and the package manager they picked, and meant `mergeExampleDeps` never ran on that path at all. The template still wins on everything it declares; `name` and `packageManager` stay with the scaffold, and the three dependency maps plus `scripts` merge key by key.

  **A `/tree/<branch>` URL no longer needs a subpath.** The pattern demanded one, so a whole repository at a named branch was unexpressible and a template repository could not scaffold from the branch under test in its own CI. The parser is now `parseGitHubExampleUrl`, exported and tested on its own. A branch is still one path segment: `feature/my-branch` parses as branch `feature` with subpath `my-branch`, because nothing in the URL says which slash is the boundary, and the JSDoc now says so instead of claiming multi-segment support the pattern never had.

  **The copy filter matches path segments.** It matched substrings, so `.gitignore` and every file under `.github/` were dropped along with the `.git` directory they were never aimed at, and a capability folder named `pnpm-lock.yaml-parser` went with the lockfile. `bun.lock` and `bun.lockb` join the lockfiles that are deliberately excluded.

  **Breaking (0.x, so `minor`): `DeferralStore` gains a required `replaceStepState` member.** A custom store implementation has to add it; the two shipped backends already have it, so a deployment that uses `memory` or `sqlite` is unaffected.

  **`DeferralStore.replaceStepState`** compare-and-swaps the opaque `stepState` slot of a record that is still `deferred`, leaving every other field alone. It is the one write that edits a deferred record in place rather than settling it, and it exists for compaction: a thread that has outgrown the model's context window can only be shrunk while the exchange stays deferred. The compare is a `stepStateFingerprint` of the state the caller read, so two rewrites of the same read produce one winner, and the swap only matches a still-deferred row, so a resume that got there first wins outright. Both shipped backends implement it, and the cross-runtime suite proves they agree.

  **`replaceDeferredThread` and `assertResumableThread`** (`@routecraft/ai`) put an agent's thread through that swap safely. A rewrite that breaks tool-call / tool-result pairing, duplicates a call id, empties the thread, or drops the deferred call the approver's answer lands on is refused with **`AI1008`** before the store is touched, so a failed compaction costs nothing and the run resumes uncompacted.

  **`AI1009`** separates "the prompt does not fit the model's context window" from every other dispatch failure. The two need opposite reactions and no shared status code distinguishes them; the classifier reads OpenAI's `context_length_exceeded` where there is one and matches the phrasings Anthropic, Google and the local runtimes actually emit otherwise. Every other failure is rethrown untouched, with its retryability intact.

- [#788](https://github.com/routecraftjs/routecraft/pull/788) [`b2f8e48`](https://github.com/routecraftjs/routecraft/commit/b2f8e48e1e59befc935d7b91b121d250a67af11a) Thanks [@claude](https://github.com/apps/claude)! - Scaffolding from a repository resolves the ref, keeps one routecraft version, and leaves the template's CI behind ([#777](https://github.com/routecraftjs/routecraft/issues/777)).

  Three defects on the `--example <url>` path, all found by using it.

  **A ref whose name contains a slash could not be scaffolded from.** `parseGitHubExampleUrl` took one path segment as the branch and the rest as a subpath, so `/tree/claude/my-branch` cloned branch `claude` and looked for `my-branch/` inside it. Every `feat/*`, `fix/*` and `claude/*` branch failed, and the README documented it as unresolvable.

  It is resolvable, and the remote answers it. The scaffolder now asks `git ls-remote --heads --tags` before cloning and takes the longest ref that prefixes the remainder. That is exact rather than a heuristic: git stores refs as a directory tree, so `refs/heads/claude` and `refs/heads/claude/foo` cannot both exist, and at most one ref can prefix any remainder. It is also what GitHub does when it renders a `/tree/` URL.

  ```bash
  # worked before and still does
  --example https://github.com/you/repo
  --example https://github.com/you/repo/tree/main/examples/api
  --example https://github.com/you/repo/tree/v1.2.0

  # refused before, works now
  --example https://github.com/you/repo/tree/feature/login
  ```

  A plain repository URL now takes the repository's default branch instead of assuming `main`, so a repository whose default is `master` or `trunk` scaffolds too. A miss names the branches and tags that do exist, bounded, rather than suggesting the repository might not be public when it just answered with its ref list.

  **An example's routecraft pins overrode the version you asked for.** The manifest merge let the example win, so `create-routecraft@canary` against a template pinning an older canary installed that older canary, and `@routecraft/os` came out eight days behind the rest of a train the changeset config versions in lockstep. Every `@routecraft/*` entry now takes this scaffolder's own version, whatever the template pins. Everything else the template declares is still its own choice.

  **`.github/workflows` is no longer copied.** A template's CI tests that template against its own branches and secrets. Copied into a new project it either fails on the first push or is guarded into never running and sits there as config nobody wrote. Excluded by path prefix rather than by segment name, so a capability folder called `workflows/` survives.

## 0.6.0

### Patch Changes

- [#560](https://github.com/routecraftjs/routecraft/pull/560) [`4c7cbfa`](https://github.com/routecraftjs/routecraft/commit/4c7cbfab2146dbc9625649b40ffe9d6b72e734b3) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Raise the `@inquirer/prompts` dependency floor to `^8.5.2`.
