---
"@routecraft/routecraft": minor
---

Finish the role model's option laws: arity is no longer a discriminant, and "key present" means supplied.

Three residuals survived the #532 refactor and are cleared here.

`mail()`'s read side split on argument count: `mail(folder)` returned an `Enricher` and `mail(folder, options)` returned a `Source`, so adding a second argument changed the ROLE. That is law 2 ("options never change the adapter's type") expressed positionally, and law 4 only ever sanctioned KEY presence. Both shapes now return one read adapter (`MailFolderAdapter`) carrying `subscribe` and `fetch`, with the operation keyword picking between them. The change is additive: everything that compiled before still compiles and behaves identically, while `.from(mail('INBOX'))` and `.enrich(mail('INBOX', opts))` are newly valid.

`json()`, `html()`, `csv()`, `jsonl()` and `xml()` treated a supplied-but-undefined `path` as an absent one, so options built programmatically (`json({ ...cfg })` where `cfg.path` is `string | undefined`) silently produced a transformer that ignored every file option beside it. That is the absence-axis twin of the widened-boolean hazard the laws already ban. A supplied `path` of `undefined` now throws `RC5003` like the empty string does; only an omitted key selects the transformer role. TypeScript already rejects the typed form under `exactOptionalPropertyTypes`, so this is the runtime backstop for untyped callers and casts. All five factories now share one guard (`selectsFileRole`) rather than hand-rolling the check, so the rule cannot drift apart between them again.

The chunked adapters advertised `Source & Destination & Enricher` but nothing exercised the send and fetch roles of a chunked adapter, leaving the type's claim unverified. `.to(csv({ chunked: true }))` and `.enrich(csv({ chunked: true }))` are now covered, confirming that `chunked` concerns the subscribe role only.

`.standards/adapter-architecture.md` gains law 4b (arity is not a discriminant) and tightens law 4's definition of presence.
