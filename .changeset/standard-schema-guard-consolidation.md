---
"@routecraft/routecraft": minor
"@routecraft/testing": minor
"@routecraft/ai": minor
---

One shared guard for "is this a Standard Schema", and one `isThenable` (#545, #575).

Mostly consolidation. The thenable defect itself was fixed in #660; this is the follow-up that stops the duplication growing back. Three behaviour changes come with it, each described below: callable schemas such as ArkType are now accepted where they were refused, an ArkType suspension digest changes (denying and re-asking any such exchange parked across the upgrade), and an event handler returning a bare thenable is no longer misreported as having thrown.

**`isStandardSchema(value)` is new public API**, exported from `@routecraft/routecraft` beside `formatSchemaIssues` and `validateAgainst`. It answers one question: does this value carry a callable `~standard.validate`, and so can it be handed to `validateAgainst`, which dereferences that property unguarded. Seven boundaries hand-rolled the same index cast and predicate before it existed. Each of them keeps its own throw, its own error code and its own message, because those differ per boundary on purpose: a plugin option validator throws a plain `Error`, the fn registry throws `RC5003` naming the fn, and the structured-text fallback declines with `undefined` rather than throwing at all. Only the cast and the test moved. It is built on the existing `standardExtensionOf` rather than re-deriving the null-and-object-and-bag extraction, which would have added another spelling of the thing this change removes.

`isThenable` is now one implementation in core, covering the three core sites that had their own. It stays core-internal, so it is not part of this or any public surface, and `@routecraft/ai` keeps its own copy across the package boundary.

**A callable schema now reads as a schema.** `standardExtensionOf` admitted only `typeof "object"`, so an ArkType schema, which is a function object carrying `~standard`, read as carrying no bag at all. `validateAgainst` validates one happily, so the test was narrower than the validation it feeds. Two consequences, both improvements, one with a migration note:

- ArkType schemas are accepted wherever the new guard runs, rather than being refused by boundaries that previously indexed `~standard` directly.
- A suspension parked under an ArkType schema now hashes its rendered JSON Schema rather than falling back to vendor and version. That fallback is identical for every schema a vendor produces, so the changed-schema half of the resume compatibility check could not fire for ArkType at all: schema edits under a parked ArkType exchange went uncaught. They are caught now. **The digest changes for ArkType schemas only** (Zod and the other object-shaped libraries are byte-identical). Know what that costs on the upgrade: an ArkType suspension parked before this release resumes into a hash mismatch, and a mismatch is not a soft check failure. It reaches `refuseContinuation`, which **denies the record** (RC5048, reason `continuation changed`) and **re-asks the approver**, so the parked exchange does not resume and a human is asked again. Settle or drain ArkType-schema suspensions before upgrading if a re-ask is disruptive.

**One behaviour fix comes with it.** An event handler that returned a thenable rather than a `Promise` was logged as having thrown when it had returned normally: the bus followed its duck-type with `result.catch(...)`, which a thenable does not carry, so the call threw from inside the surrounding `try`. The thenable is adapted before `catch` is reached, and a rejecting one is still caught and logged as a rejection.

`agent()`'s two output guards collapsed into one because both already produced the same message. `validateFnOptions` adopts partially: it keeps a first guard that rejects a value that is not schema-shaped at all, separately from the shared predicate rejecting a schema-shaped value with no validator, because the two messages diagnose different mistakes.
