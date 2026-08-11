---
"@routecraft/routecraft": minor
---

Resumed continuations honour the filter chain, and the detached definition is derived per position (#580).

A resumed exchange's continuation ran under a `RouteDefinition` assembled as an object literal with empty filter arrays, inherited from the `.debounce()` release path. The pre-from filter chain therefore did not apply to execution two at all, and the one position that did (`error`) applied because it had been copied by hand rather than chosen.

**`.concurrency()` now bounds resumed continuations.** This is the user-visible fix. A route declaring `.concurrency({ max: 5 })` because a downstream tolerates five calls at a time was getting five ingress executions **plus unbounded resumes** against that same downstream, so a batch of approvals landing together could overrun the limit the bulkhead exists to enforce. Ingress executions and resumed continuations now compete for the same limiter.

**`.retry()` and `.timeout()` now apply to execution two.** Both are safe against the store transition: attempts and deadlines run before any terminal outcome is recorded, so a retried continuation never spends the approval it was answering.

**Upgrade note.** A route that already declares route-scope `.retry()` alongside a `.suspend()` gains at-least-once execution of the steps after the suspend point, where the chain previously did not reach them. That is the same guarantee those retries already gave the steps before the suspend, but it is new for the continuation and needs no opt-in, so make continuation steps idempotent or move side effects a downstream cannot absorb twice behind a step-scope wrapper you control. This is why the bump is `minor` rather than `patch`: previously documented "does not run" behaviour becomes "runs".

**Which positions apply is now declared, not inherited.** `pipeline/chain-policy.ts` keys a survival record by `Exclude<keyof RouteDefinition, NonChainField>`, so every chain position states an answer for a resume and for a debounce release separately, each with its reason recorded beside it. Adding any field to `RouteDefinition` fails the build until it is classified, which is what stops a future chain position from silently not applying to continuations.

Positions that stay off on a resume, with the reasoning now in code and on the [filter chain page](https://routecraft.dev/docs/advanced/filter-chain): `authorize` (a restored principal fails `RC5043` by design, so copying it would refuse every resume), `parse` (the stored body is already parsed), `input` (it validates the shape arriving at the route, and execution two starts mid-pipeline with a transformed body), `throttle` (it admits new work, and the exchange was admitted on execution one), `circuitBreaker` (a continuation runs after the resume has claimed the suspension, so fast-failing there would spend the approval; its home is the resume ingress route's own chain), and `cache` (already refused at build alongside a reachable suspend).

`.debounce()` release behaviour is unchanged, now because its own policy says so rather than by sharing one.
