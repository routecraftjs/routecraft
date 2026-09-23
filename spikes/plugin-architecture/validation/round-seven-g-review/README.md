# Round 7g review evidence

Measured implementation: `85f7506a158c3e50230a7bf541ddbf66a7e55f3d`.
Resume reference inspected: `ce0c38ee57f98ab8eae169525c40e8504f2d8fa5`.

These tests characterize the reviewed head. Passing means the documented
failure was reproduced, not that the behavior is acceptable. There are no
implementation changes or new mutation-score claims here.

Use Bun 1.3.11 and Node 22.23.2 on PATH for the recorded environment. At the
repository root:

```sh
bun install --frozen-lockfile
```

From `spikes/plugin-architecture`:

```sh
bun run verify
bun run verify:packed
bun test validation/round-seven-g-review/probes.test.ts
bun ../../node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --module preserve --moduleResolution bundler --target ES2022 --types bun-types --allowImportingTsExtensions validation/round-seven-g-review/point-types.ts
```

`verify-final.log` is the completed requested verification run. It includes
the unchanged-copy mutation control, acceptance results, mutation results,
compiler controls, import gate and module-diagram check. `packed-final.log`
is the separately requested packed run. `probes-final.log` is the new suite.
`point-types.log` records the strict compiler exit for the no-cast point
example. `install-1.3.11-node22.log` records the successful final root install.

| Probe | What it measures |
|---|---|
| R1, ordinary and error-path cases | Cancellation while the store write is paused |
| R2 | Notification paused across ingress cancellation |
| R3 | Permanent grant arrays colliding under comma joining |
| R4 | Failed first attempt remains tracked after a successful retry |
| R5 | Step state replaced successfully while the resume door waits |
| R6 | Same-named step on a different route receives source resumption state |
| R7 | Store swap released after bounded shutdown has disposed resources |
| R8 | Shared descriptor's timer allocation and clearing across two contexts |
| R9 | A later refusal loses the earlier handler's replacement envelope |
| R10 | Type-valid deferred point loses its decision through invoke |
| R11, two cases | Sparse arrays and numeric-looking non-index properties, with direct shipped-codec controls |
| R12 | Missing deferred route removes the declared door policy |
| R13 | Duplicate terminal events with different id meanings |
| R14 | Decode failure after CAS is not recorded as a failed outcome |

The stores use in-memory SQLite. Race probes use explicit promise latches.
R8 intercepts timer creation and clearing rather than depending on timer
scheduling; it restores the globals in `finally`. The point compiler fixture
is separate because ordinary Bun test execution erases types. It demonstrates
acceptance of the public contract, not type safety of arbitrary plugin code.

The initial environment had no Bun. A preliminary Bun 1.4.2/Node 24 install
failed in a native dependency's Node-header extraction. That runtime's first
verification attempt also hit the scan test's 500 ms fallback. Those failures
are recorded as qualifications in the report, not attributed to a diagnosed
framework defect. Final installation and both requested verification commands
completed successfully in the environment above. Tool downloads, caches and
intermediate logs are ignored and are not part of the review deliverable.
