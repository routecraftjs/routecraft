# Round-five and round-six evidence

Run from `spikes/plugin-architecture`:

```sh
bun run verify
bun run demo
bun run validation/round-two/uncooperative.ts
```

`verify` runs strict typechecking, acceptance tests (including the packed external consumer), behavioral mutation controls, the resolved import gate, and compiler negative controls. No package source outside this spike is modified.

- `process.ts`: child process for durable nested agent continuation, transaction crash and concurrent CAS. The parent waits for durable proof files, kills the parked process with SIGKILL and resumes from another PID. Temporary databases are deleted after assertions.
- `packed.ts`: builds JavaScript and declarations, packs a tarball, installs it in a fresh temporary consumer, then compiles and executes `external.fixture.ts`. The consumer imports only the package entry point. Type support is copied; workspace source aliases are not installed. Private subpath import is a negative control.
- `mutations.ts`: edits a disposable source copy, requires a behavioral test failure for each mutant, and refuses to count parse/import errors as a successful kill. Run it again after changing either the implementation or assertions.
- `type-controls.ts`: verifies ordinary strict compiler options, then removes each `@ts-expect-error` individually and requires rejection.
- `boundaries.ts`: enumerates imports using the TypeScript AST and resolves relative paths against an explicit allowed graph. The allowlist is closed over `src/v2` in both directions, the walk covers dynamic `import()` and `require()` as well as top-level statements, and a computed specifier is refused. This is a gate for the ten implementation modules, not a claim that project references enforce privacy.
- `diagram.ts`: re-derives the module graph from the AST and compares it to the Mermaid block in `DIAGRAMS.md`. A drawn edge that does not exist and an import that is not drawn both fail, so the picture cannot quietly rot away from the code it claims to show.
- `uncooperative.ts`: separate limit probe, not an acceptance test. It prints `UNGUARDED_EFFECT_AFTER_TIMEOUT=true`, demonstrating why arbitrary in-process IO cannot be revoked by a framework timeout.

`packed.ts` stages its build, tarball and consumer outside the repository, because a generated artifact inside it is linted by the root flat config, which does not read `.gitignore`.

Generated tarballs, declarations, temporary compiler negatives and lint reports are ignored. The implementation is `src/v2`; the previous measurement scripts one directory above still describe the earlier source revision.
