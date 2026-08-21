---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
"@routecraft/testing": minor
---

Suspension: securing resume is now possible, and still yours to define (#632).

**The framework ships a policy point, not a policy language.** How approvals work is the application's design: Routecraft has no notion of an approver, a role, a four-eyes rule, or an escalation, and shipping one would get it wrong for somebody. What it now guarantees is the part you cannot build from outside.

**`.resume({ authorize })`.** One hook on the resuming route, receiving `{ principal, parked, payload, record }`: the live principal (whatever the route's `.authenticate()` resolved), the parked principal restored from storage, the submission exactly as it arrived, and the record's context view (`id`, `meta`, `routeId`, `suspendedAt`, `expiresAt`). Never the parked body: the hook runs before the principal is authorized, so a body-reading hook would put the parked payload in front of exactly the party the check exists to reject. `payload` is RAW, because `schema` validation runs only once the hook has passed: a submission the hook refuses never reaches the validator and never spends the link. Return false or throw to refuse.

**`.suspend({ meta })`, identical on both surfaces.** Plain JSON under the exchange's own rules (`RC5042`), persisted verbatim, never interpreted, never surfaced on the acknowledgment, and handed to the hook at revive. `ctx.suspend()` takes exactly what `.suspend()` takes, so an agent-raised park and a route-raised one are one mechanism with one resuming path. Because `meta` lives only on the record, a parker that snapshots its policy there gets policy-travels-with-the-park by construction rather than by a tamper check.

**The refusal contract.** Every refusal happens before the store's compare-and-swap, so saying no never spends the rightful principal's single-use link, and before the record's lifecycle is disclosed, so a refused caller cannot learn whether the park is still open. `false`, a throw, and a hook that never settles are one `RC5056` with one message, distinguished only in the boundary log, because a hook whose failures can be told apart from outside is an oracle for what it knows; a thrown cause never reaches the wire. An async hook is bounded by the route's own lifecycle rather than a framework knob (the route's stop signal, widened by an enclosing `.timeout()`), and the suspension's deadline is re-checked once it resolves so an overrun reports `RC5047`.

**With no hook the door is bearer**, exactly as before. Resume is securable, not secured; the docs say so in the reference rather than warning about it at startup.

**Per-call resume credentials** (`RC5055`). A parallel agent tool batch produces one park while each handler mints its own credential through `ex.suspension.tokenFor(call)`. A recipient sent a link by a handler that then lost the park is refused instead of resuming the winner's park, record-only and before anything else. `tokenFor` refuses a missing binding at the mint site rather than silently handing back an unbound credential.

**The pre-claim window is ordered, and the ordering is the security property.** The deadline arm and the continuation arm each settle a record and drive the suspended route's error channel, so the credential binding and the hook run above both, and above the settled-state disclosure. The hash is compared non-destructively for the same reason. Previously either transition was reachable by a party the checks exist to reject, who could deny the record, burn the rightful principal's claim, and drive an approver notification with it.

**Docs.** A "Securing resume" section on the resume reference carries six patterns as real running code, each proven on its accept and refuse path in `packages/routecraft/test/securing-resume.bun.test.ts`: four eyes, scope gate, channel segmentation, policy travels with the park, same-user continuation, and threshold by scope over a narrowed payload.

**Breaking.** `.suspend({ expect })` is now `.suspend({ schema })` and the option is OPTIONAL: a site that declares none parks with no contract, validates nothing at the ingress, and types `ex.suspension.result` as `unknown`. The rename carries through `ctx.suspend()`, `SuspendError`, `testFn`'s structural suspend, the `Suspended` acknowledgment's wire field (both the advertised JSON Schema and the structural validator), the stored record, and `describeExpect` to `describeSchema`. The sqlite store migrates itself. `SuspensionExpect` is now `SuspensionSchema` and carries an `absent` sentinel distinct from the degraded fallback, so a site edited between "declared but unrenderable" and "no schema at all" moves the digest instead of quietly accepting anything.

**Breaking.** `Suspended` no longer carries `question` or `reason`, and neither suspend surface accepts them. The acknowledgment is `{ status, suspensionId, token, schema?, expiresAt? }`: it crosses the wire to whoever called the route, so it carries the CONTRACT and nothing else, while everything policy-shaped lives on the record where only the hook and an operator can read it. `SuspendError`, `ctx.suspend()`, `SuspendSignal`, both stores, and the advertised MCP schema drop the fields together. Put what you were carrying there into `meta`, or send it through the notification step that already runs before the park.
