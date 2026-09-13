---
"create-routecraft": minor
---

One template, laid out for `craft start`, and CI runs the scaffold's own tests (#776).

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
