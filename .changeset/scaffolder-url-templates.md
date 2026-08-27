---
"create-routecraft": minor
"@routecraft/routecraft": minor
"@routecraft/ai": minor
---

Scaffolding from a repository keeps the files it copies, and parked agent threads can be rewritten in place.

**The scaffolder no longer loses files (#653).** A built-in example copied with `force: false` and no `errorOnExist`, so an example file landing where the base template already wrote one vanished with nothing in the output to say so. The collisions are now walked before the copy and named afterwards.

**A URL example's `package.json` is merged, not overwritten.** It used to replace the base manifest outright, which threw away the project name the user had just typed and the package manager they picked, and meant `mergeExampleDeps` never ran on that path at all. The template still wins on everything it declares; `name` and `packageManager` stay with the scaffold, and the three dependency maps plus `scripts` merge key by key.

**The copy filter matches path segments.** It matched substrings, so `.gitignore` and every file under `.github/` were dropped along with the `.git` directory they were never aimed at, and a capability folder named `pnpm-lock.yaml-parser` went with the lockfile. `bun.lock` and `bun.lockb` join the lockfiles that are deliberately excluded.

**`SuspensionStore.replaceStepState`** compare-and-swaps the opaque `stepState` slot of a record that is still `suspended`, leaving every other field alone. It is the one write that edits a parked record in place rather than settling it, and it exists for compaction: a thread that has outgrown the model's context window can only be shrunk while the exchange stays parked. The compare is a `stepStateFingerprint` of the state the caller read, so two rewrites of the same read produce one winner, and the swap only matches a still-parked row, so a resume that got there first wins outright. Both shipped backends implement it.

**`replaceParkedThread` and `assertResumableThread`** (`@routecraft/ai`) put an agent's thread through that swap safely. A rewrite that breaks tool-call / tool-result pairing, duplicates a call id, empties the thread, or drops the suspended call the approver's answer lands on is refused with **`AI1008`** before the store is touched, so a failed compaction costs nothing and the run resumes uncompacted.

**`AI1009`** separates "the prompt does not fit the model's context window" from every other dispatch failure. The two need opposite reactions and no shared status code distinguishes them; the classifier reads OpenAI's `context_length_exceeded` where there is one and matches the phrasings Anthropic, Google and the local runtimes actually emit otherwise. Every other failure is rethrown untouched, with its retryability intact.
