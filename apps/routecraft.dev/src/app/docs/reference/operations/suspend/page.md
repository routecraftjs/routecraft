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
| `ttl` | `number \| "30s" \| "15m" \| "72h" \| "7d"` | none | No | How long the suspension stays resumable. Omit for no expiry. |

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

Two more refusals happen at runtime, both deliberately at suspend time rather than at resume:

- An exchange holding anything that is not plain JSON data (a function, a class instance, a `Secret`) fails with [`RC5042`](/docs/reference/errors#rc-5042) naming the offending path.
- A context whose routes can reach a suspend but which configured no [`suspension`](/docs/reference/configuration#suspension) block fails at startup with [`RC5052`](/docs/reference/errors#rc-5052).

{% callout type="warning" title="Durable from the suspend point onward" %}
Suspension guarantees durability from a **declared** suspend point. It is not general crash recovery: if the process dies at step 4 of a route that never reached a `.suspend()`, that exchange is gone. Routecraft does not checkpoint at every step boundary.
{% /callout %}

## Related

- [`.resume()`](/docs/reference/operations/resume) -- the other half.
- [Configuration → suspension](/docs/reference/configuration#suspension) -- where parked exchanges are stored and how tokens are signed.
- [Events](/docs/reference/events) -- `route:exchange:suspended`, `:resumed`, `:expired`.
