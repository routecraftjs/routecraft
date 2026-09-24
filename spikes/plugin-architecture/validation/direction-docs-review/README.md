# Direction-docs review: executable evidence

Evidence for `reviews/OPUS-DIRECTION-DOCS.md`, measured on
`dd53ef3910eb2b665b9b9a38b28275be3dd550a1` (branch `validation/round-six`).
Nothing under `src/v2/`, `test/round-two/` or `validation/round-two/` was
changed.

```sh
bun install                                   # at the repository root
bun test validation/direction-docs-review     # from spikes/plugin-architecture
```

Each probe asserts what the proof of concept **does**, so a passing probe is
evidence for the finding it names. When the proof of concept is fixed, the
probe fails and should be inverted into an acceptance test, as round 7g did
with its predecessors.

| Probe | What it shows | Where the docs said otherwise |
|---|---|---|
| D1 | A refused run emits `exchange:started` and no `exchange:refused` | page 03, Events |
| D2 | The error ring hears an admission refusal, not an entry refusal | `exchange-path` figure, "a refusal at admission or entry; on a first delivery the error ring is told" |
| D3 | A failure a route-level retry absorbs never reaches the error ring: the ring sits outside the wrapper chain | unstated on page 03 |
| D4 | The exit ring runs only over completed exchanges, never on a deferred or failed run | unstated; "exit" reads as "always" |
| D5 | Any plugin holds `ctx.execution` and can resume any continuation of a route that declares no `.authorize()` or `.resumable()`, with no identity at all | the four-sockets page names no execution socket; page 07's "default policy" row reads as closed |
| D6 | A missing provider fails as `MISSING_PORT` at construction | `installation` figure showed `UNAVAILABLE_PORT` |
| D7 | The packed fixture's `acme.store` replaces `records.atomic@1`; the deferral plugin still provides `execution.continuations@2` | `kernel-boundary` figure said it provides CONTINUATIONS |
| D8 | A wrapper declaring `allRuns` runs on the error channel | `exchange-path` figure, "nothing in the chain runs on the error channel" |
| D9 | A plugin-declared point name is not checked against the owner's namespace | page 02, "Everything the plugin names lives under it" |
| D10 | Unanchored handlers at one point run in owner-id order; `acme.early` runs before `routecraft.auth`'s gate, and the gate declares no anchor to land after | page 03, "in the order the anchors put them in" |

`probes.log` is the run of these ten probes and `verify.log` the spike's own
`bun run verify` at the same commit, both taken before the commit that
carries them.
