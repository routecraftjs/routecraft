---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
"@routecraft/testing": minor
---

Suspension: securing resume is now possible, and still yours to define (#632).

**The framework ships a policy point, not a policy language.** How approvals work is the application's design: Routecraft has no notion of an approver, a role, a four-eyes rule, or an escalation, and shipping one would get it wrong for somebody. What it now guarantees is the part you cannot build from outside.

**`.resume({ authorize })`.** One hook on the answering route, receiving the answerer's live principal (whatever the route's `.authenticate()` resolved), the parked principal restored from storage, and the record's metadata view: `id`, `meta`, `question`, `reason`, `routeId`, `position`, `suspendedAt`, `expiresAt`. Never the parked body: the hook runs before the answerer is authorized, so a body-reading hook would put the parked payload in front of exactly the party the check exists to reject. Return false or throw to refuse.

**`.suspend({ meta })`, identical on both surfaces.** Plain JSON under the exchange's own rules (`RC5042`), persisted verbatim, never interpreted, and handed to the hook at revive. `ctx.suspend()` takes exactly what `.suspend()` takes, so an agent-raised question and a route-raised one are one mechanism with one answering path. `question` and `reason` join the static surface for the same reason. Because `meta` lives only on the record, a parker that snapshots its policy there gets policy-travels-with-the-question by construction rather than by a tamper check.

**The refusal contract.** Every refusal happens before the store's compare-and-swap, so saying no never spends the rightful answerer's single-use answer, and before the record's lifecycle is disclosed, so a refused caller cannot learn whether the question is still open. `false`, a throw, and a hook that never settles are one `RC5056` with one message, distinguished only in the boundary log, because a hook whose failures can be told apart from outside is an oracle for what it knows; a thrown cause never reaches the wire. An async hook is bounded by the route's own `.timeout()` rather than a framework knob, and the suspension's deadline is re-checked once it resolves so an overrun reports `RC5047`.

**With no hook the door is bearer**, exactly as before. Resume is securable, not secured; the docs say so in the reference rather than warning about it at startup.

**Per-call resume credentials** (`RC5055`). A parallel agent tool batch produces one park and one question while each handler mints its own credential through `ex.suspension.tokenFor(call)`. An approver sent a link by a handler that then lost the park is refused instead of answering the winner's question, record-only and before anything else.

**The pre-claim window is ordered, and the ordering is the security property.** The deadline arm and the continuation arm each settle a record and drive the suspended route's error channel, so the credential binding and the hook run above both, and above the settled-state disclosure. The hash is compared non-destructively for the same reason. Previously either transition was reachable by a party the checks exist to reject, who could deny the record, burn the rightful answerer's claim, and drive an approver notification with it.

**Docs.** A "Securing resume" section on the resume reference carries five patterns as real running code, each proven on its accept and refuse path in `packages/routecraft/test/securing-resume.bun.test.ts`: four eyes, scope gate, channel segmentation, policy travels with the question, same-user continuation.

**Breaking.** `.suspend({ expect })` is now `.suspend({ schema })` and the option is OPTIONAL: a site that declares none parks with no contract, validates nothing at the ingress, and types `ex.suspension.result` as `unknown`. The rename carries through `ctx.suspend()`, `SuspendError`, `testFn`'s structural suspend, the `Suspended` acknowledgment's wire field (both the advertised JSON Schema and the structural validator), the stored record, and `describeExpect` to `describeSchema`. The sqlite store migrates itself. `SuspensionExpect` is now `SuspensionSchema` and carries an `absent` sentinel distinct from the degraded fallback, so a site edited between "declared but unrenderable" and "no schema at all" moves the digest instead of quietly accepting anything.
