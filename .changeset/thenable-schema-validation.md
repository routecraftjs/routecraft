---
"@routecraft/routecraft": minor
"@routecraft/testing": minor
"@routecraft/ai": minor
---

A schema whose `validate()` returns a thenable now validates instead of passing (#545, #575).

Standard Schema allows `validate()` to return a result or a promise of one, and "promise" there is the thenable contract, not the `Promise` class. Every validation boundary in the framework tested for the class, so a schema returning a plain thenable was missed. The miss did not skip validation: the thenable object itself became the result record, its absent `issues` read as success, and the caller's original unvalidated input came back marked ok.

That reached route `.input()`, route `.output()` (which then stamped the exchange as output-validated), suspension resume payloads, MCP advertised-output enforcement, `schema()`, `testFn`, and the MCP options validator. `.input()` is a boundary control, so a caller who asked for validation silently got none.

**What changes.** Such a schema now decides the outcome it always meant to. A route that used to accept a body its schema rejects now fails it with `RC5002`. Real `Promise`-returning schemas are unaffected.

**The one thing to know.** Awaiting an arbitrary thenable runs schema-author `then` code on the validation path, so a schema that never settles now hangs the validation where it used to silently pass. That is the safer of the two failures, but it is a new one.

**The one thing to know, part two.** Nothing bounds that wait. `.input()` is position #4 of the pre-from filter chain and `.timeout()` is #8, so a route timeout sits below validation and cannot reclaim a hung one.

The AI SDK bridge (`jsonSchema({ validate })`) is a synchronous seam and refuses asynchrony rather than awaiting it. It now refuses a thenable too, where it used to return `{ success: true, value: undefined }`, passing and corrupting at once.

**A schema returning a non-record now fails with a message instead of crashing, synchronous schemas included.** A `validate()` that produced `undefined`, `null` or a primitive rather than a result record killed `validateAgainst` with a raw `TypeError` out of framework internals, in two places: `undefined` and `null` on the `issues` read, a primitive on the `value` check. It now comes back as an ordinary failure naming what the schema returned. This was never thenable-specific; the guard sits after the await, so the synchronous path is covered by the same line.

`validateWithSchema` for MCP plugin options changes on its success path as well: a schema that passes without returning a `value` now yields the caller's own options rather than throwing, and the remaining "produced undefined options" refusal fires only on an explicit `{ value: undefined }`.

`@routecraft/testing` gains `thenableSchema(outcome)`, a Standard Schema whose `validate()` returns a non-`Promise` thenable, for holding your own validation boundaries to the contract rather than the class.
