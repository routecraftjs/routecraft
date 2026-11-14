---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
"@routecraft/testing": minor
"@routecraft/eslint-plugin-routecraft": minor
---

One defer contract: a resume payload is `input` everywhere, a step declares that it defers or resumes and the kernel hands it the handle, and a third party can build what the shipped `.defer()`, `.resume()` and agent step are built on (#809, #817).

**Breaking: the payload is `input`.** `.defer({ schema })` is `.defer({ input })`, a resume request (the mapper's return value and the unmapped `.resume()` body) is `{ token, input }` in place of `{ token, result }`, `ex.deferral.result` is `ex.deferral.input`, and the header `routecraft.deferral.result` is `routecraft.deferral.input`. Whatever builds an approval link or form sends `input`.

**Breaking: deferring is declared.** `DeferSignal`, `markDeferCapable`, `peekResumeStepState`, `deferAside`, `reviveDeferral`, `deferralScope`, `decodePersistable` and `decodeOutcome` leave the entry. In their place:

- A step declares `step(fn, { defers: { revival: "next-step" | "this-step" } })`, or `[DEFERS]()` on a raw step or an adapter, and is handed `ctx.defer`, with `ctx.defer.revived`, `ctx.defer.refused` and `ctx.defer.aside()`.
- A resume door declares `step(fn, { resumes: true })`, or `[RESUMES]()`, and is handed `ctx.resume`. The kernel records the principal the route verified; a request naming `resumedBy` is `RC5003`.
- A step result naming a deferral that the kernel did not issue is refused with `RC5032`.
- A plugin reads and drives parked exchanges through `c.continuations` (`get`, `list`, `verifyToken`, `resume`, `sweep`, `mintToken`, `rewriteStepState`), which replaces `c.execution.resume` and `c.execution.sweep`. An adapter reaches the read-only half with `continuationsOf(exchange)`.

**Breaking: an adapter does not read the context off an exchange.** `getExchangeContext` and `getExchangeRoute` leave the entry. A plugin's own state is an `applicationState<T>()` holder (`set(c.application, value)` in `bind`, `of(exchange)` in an adapter, `get(context.application)` in a source), the logger is `exchange.logger`, trace headers are decided by `sendsTraceContextFor(exchange)`, and background work is `c.execution.trackTask(task, { route })`. The `llm()` and `embedding()` adapters no longer expose `mergedOptions(context)`.

**Breaking: the `CONTINUATIONS` port is `routecraft.continuations@2`.** The kernel encodes `stepState`, `meta` and the settled outcome before the store sees them, so a custom `DeferralStore` persists them as the JSON they arrive as. `deferralStoreConformance(name, open, runner)` in `@routecraft/testing` is the suite the shipped stores pass; run it against your own. The signer is typed `ResumeTokenSigning`.

**A parked exchange finds its defer site by what follows it.** A step added or removed ahead of a defer point no longer refuses the exchanges parked there. Two sites followed by identical steps that both moved are refused with `RC5048` as ambiguous. The `RC5032` and `RC5048` messages say what to change.

**New lint rule `restrict-continuation-minting`**, an error in both presets: `continuations.mintToken()`, `resume()` and `rewriteStepState()` run no door policy, so each call site is sanctioned with a scoped disable comment or a per-file override.

Also off the entry, none of which a route needs: `ResolvedSampleOptions`, `ResolvedDedupeOptions`, `ResolvedThrottleOptions`, `ResolvedCircuitBreakerOptions`, `RouteEnablement` and `hashExchangeBody`.

See section 18 of the 0.7 to 0.8 migration guide.
