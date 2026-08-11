---
title: suspend
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
suspend(options: { expect: StandardSchemaV1; ttl?: Duration }): RouteBuilder<Current>
```

Park the exchange durably and exit the pipeline. The run that reaches a `.suspend()` ends there and answers immediately; the exchange continues from the next step later, when [`.resume()`](/docs/reference/operations/resume) arrives with the answer.

```ts
craft()
  .id('payout')
  .input({ body: PayoutRequest })
  .from(http({ path: '/payouts', method: 'POST' }))
  .choice(
    when(
      (ex) => ex.body.amountCents >= 50_000,
      (b) =>
        b
          .tap(direct('notify-approver'))
          .suspend({ expect: Approval, ttl: '72h' })
          .filter((ex) =>
            ex.suspension.result.approved
              ? true
              : { reason: `rejected by ${ex.suspension.resumedBy?.subject}` },
          ),
    ),
  )
  .transform((payout) => executePayout(payout))
  .to(log())
```

| Option | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `expect` | `StandardSchemaV1` | -- | Yes | What a valid answer looks like. Types `ex.suspension.result` for every step after the suspend, and is what the candidate answer is validated against at resume time. |
| `ttl` | `Duration`: milliseconds, or `"<n><unit>"` with unit `ms` / `s` / `m` / `h` / `d` | none | No | How long the suspension stays resumable, for example `"500ms"`, `"30s"`, `"72h"`, `"7d"`. Omit for no expiry. |

## Execution one always answers

A durable suspend cannot hold a caller: the answer arrives in hours or days and the process will be restarted first. So the run terminates at the suspend and returns a `Suspended` value instead of the route's declared output.

```jsonc
{
  "status": "suspended",
  "suspensionId": "3f1c…~0",
  "token": "eyJ2Ijox…",       // signed, single use
  "expect": { "type": "object", … },  // when the schema renders one
  "expiresAt": "2026-08-13T09:00:00.000Z"
}
```

A route with a reachable suspend therefore has output type `Output | Suspended`. Each source renders that its own way:

| Source | Rendering |
|--------|-----------|
| `http()` | `202 Accepted`, the `Suspended` value as the body, `Retry-After` from the `ttl` |
| `direct()` | the value itself; the caller narrows with `isSuspended(result)` |
| `cron()`, `simple()`, file | nothing on the wire, a log line only; completion is simply deferred |
| queue sources | ack, never nack: the work is parked in the suspension store, and a redelivery would ask the approver twice |

The route's real output flows to its destinations on execution two, not back to the original transport.

## Everything else is existing grammar

`.suspend()` takes two options because everything else a suspend appears to need is already a verb in the DSL:

| Concern | Where it goes |
|---------|---------------|
| Suspend only sometimes | a `.choice()` branch contains the suspend |
| Notify the approver | ordinary steps before it, e.g. `.tap(direct('notify-approver'))`. `ex.suspension.token` is readable BEFORE the suspend runs, so the message can carry a working link |
| Handle a rejection | the last step of the branch consumes the verdict, e.g. `.filter()` |
| Authorize the answerer | the resume ingress route: `.authorize()`, sender verification, a per-approver link |
| Expiry handling | `ttl` plus a route-scope `.error()`; an expired answer arrives as [`RC5047`](/docs/reference/errors#rc-5047) |

## The branch-rejoin rule

A suspend branch rejoins the main flow only if it restored the main flow's contract; otherwise it must leave the flow entirely (drop, or complete). The body crosses the park untouched, so the fast path and the approved path are indistinguishable downstream, and `ex.suspension` is never read by the main flow.

## ex.suspension

`ex.suspension` is readable anywhere in a pipeline.

| Field | Available | Description |
|-------|-----------|-------------|
| `id` | always | The suspension id this exchange would park as. |
| `token` | always | Signed, single-use resume token for that id. Mintable before the suspend runs, which is what makes a notification step useful. |
| `sequence` | always | How many times this exchange has already parked. |
| `result` | after a resume | The validated answer, typed by `expect`. |
| `resumedBy` | after a resume | Who answered, when the resume ingress had an authenticated principal. |
| `resumedAt` | after a resume | When the answer was accepted. |

## What is refused

`.suspend()` is refused at `craft()` build time where the framework could not revive the exchange, with [`RC5051`](/docs/reference/errors#rc-5051):

- **Inside `.split()`.** A durable aggregator would have to track N outstanding children across restarts. Split the work into per-item child capabilities instead: each is its own exchange and suspends independently.
- **Inside a `.multicast()` path or a `.dispatch()` target.** Those exchanges are isolated side flows, so a resumed continuation would have nowhere to rejoin.
- **Under a step-scope wrapper** (`.retry()`, `.timeout()`, `.cache()`, …), which fails with [`RC5003`](/docs/reference/errors#rc-5003). Parking is not a failure to re-attempt. Put `.error()` at route scope instead, where it also catches revival failures.
- **On a route with route-scope `.cache()`**, also [`RC5003`](/docs/reference/errors#rc-5003). The cache filters wrap the user pipeline, which a park exits and a resume re-enters partway down, so neither the check nor the store would ever run and the cache would silently do nothing. Use a step-scope `.cache()` on the expensive step instead.

Two more refusals happen outside build time, each as early as it can be known and both well before a resume:

- A context whose routes can reach a suspend (or a [`.resume()`](/docs/reference/operations/resume)) but which configured no [`suspension`](/docs/reference/configuration#suspension) block fails at **startup** with [`RC5052`](/docs/reference/errors#rc-5052).
- An exchange holding anything that is not plain JSON data (a function, a class instance, a `Secret`) fails at **suspend time**, with [`RC5042`](/docs/reference/errors#rc-5042) naming the offending path. Deliberately at the park rather than at the resume: the deploy that introduced the value is what should fail, not the approver's click days later.

{% callout type="warning" title="Durable from the suspend point onward" %}
Suspension guarantees durability from a **declared** suspend point. It is not general crash recovery: if the process dies at step 4 of a route that never reached a `.suspend()`, that exchange is gone. Routecraft does not checkpoint at every step boundary.
{% /callout %}

## Resilience on the continuation

A resume runs the continuation inside a chain **rebuilt** from the positions that survive a park, in their usual order ([pre-from filter chain](/docs/advanced/filter-chain#a-resumed-exchange-re-enters-partway-down-the-chain)). Route-scope `.error()`, `.retry()`, `.timeout()` and `.concurrency()` apply to execution two; `authorize`, `parse`, `input`, `throttle` and `circuitBreaker` do not, because they describe an exchange arriving at the route and this one arrived once. `cache` is refused at build alongside a reachable suspend. Of the positions that stay off, `throttle` and `circuitBreaker` have step-scope forms you can declare inside the continuation, where they bound the step rather than the arrival. `authorize`, `parse` and `input` have no step-scope equivalent, because each describes an exchange entering a route: work that needs one of those belongs on a route that has its own chain, reached with `.to(direct('...'))`.

{% callout type="warning" title="Route-scope `.retry()` reaches the continuation" %}
Because `.retry()` applies to execution two, the steps after a `.suspend()` are at-least-once on failure, the same as the steps before it. If your continuation does something a downstream cannot absorb twice, make it idempotent or move it behind a step-scope wrapper you control.
{% /callout %}

Two limits are worth knowing before you rely on this for money:

**A resume is spent whether or not the continuation ultimately succeeds.** `.resume()` wins the store's compare-and-swap before running anything, so once retries and the deadline have settled, a continuation that still fails records a `failed` terminal and a second answer with the same token receives that cached failure rather than a second run. This is what makes "did this already run?" answerable across a restart. A route-scope `.retry()` absorbs the transient case; what it cannot absorb needs a `.error()` handler that re-asks, not a re-click from the approver.

**A process that dies mid-continuation does not resume itself.** The record reads `resumed` with no terminal outcome, and nothing re-drives it; a later answer with the same token is told the first resume never recorded an outcome. Recovering that automatically needs a lease on the `resumed` state, which is not implemented. Until then, treat a `resumed` record with no terminal as needing an operator, and keep continuations short where the work is not idempotent.

**Expiry is discovered lazily.** A `ttl` is enforced when a late answer arrives, not by a background sweeper: an unanswered suspension sits in the store past its deadline and its route is not told until someone presents a token. A background sweeper that fires the expiry on time is not implemented yet. Until it lands, do not build a "nobody approved in 72 hours, escalate" flow on `ttl` alone: the escalation only runs if the approver eventually clicks a dead link.

## Related

- [`.resume()`](/docs/reference/operations/resume) -- the other half.
- [Configuration → suspension](/docs/reference/configuration#suspension) -- where parked exchanges are stored and how tokens are signed.
- [Events](/docs/reference/events) -- `route:exchange:suspended`, `:resumed`, `:expired`.
