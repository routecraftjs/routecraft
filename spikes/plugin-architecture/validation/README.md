# Reproducing the validation

See ../VALIDATION.md for the verdict. All measurements refer to base commit
86ec81bc6ee8ab41e4068d6a3f86b091d6643502, not PR 818's separate head.

From the repository root after bun install:

```sh
bun spikes/plugin-architecture/validation/counts.ts
bun spikes/plugin-architecture/validation/more-counts.ts
bun spikes/plugin-architecture/validation/graphs.ts
bun spikes/plugin-architecture/validation/test-surface.ts
node_modules/.bin/tsc -p spikes/plugin-architecture/validation/tsconfig.json --noEmit
bun spikes/plugin-architecture/validation/current-source.probe.ts
node_modules/.bin/tsc -b spikes/plugin-architecture/validation/boundaries/b
```

From spikes/plugin-architecture:

```sh
bun test
bun run typecheck
bun run demo
```

`adversarial.test.ts` asserts existing defects: passing means reproduced, not fixed.
The ordinary typecheck includes expected-error assertions for rejected alternatives.
The standalone `unexpressible.ts` is deliberately excluded: compile it separately
and expect nonzero exit with the three errors saved in unexpressible.txt:

```sh
node_modules/.bin/tsc --noEmit --strict --skipLibCheck --allowImportingTsExtensions \
  --moduleResolution bundler --module preserve --target es2022 \
  spikes/plugin-architecture/validation/unexpressible.ts
```

`e-installed.ts` is an encoding experiment, not a production execution engine.
The other typed alternatives are bounded proofs, not a full redesigned host.
The public-source probe uses source aliases from validation/tsconfig.json; it is
not a packed-package extraction test. Generated boundary/declaration build output
stays under this folder and is ignored by Git.
