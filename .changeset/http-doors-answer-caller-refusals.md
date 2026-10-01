---
"@routecraft/routecraft": patch
"@routecraft/cli": patch
---

The `http()` source and the ops dispatch door now answer a route failure the caller caused with a client status, through one shared mapping, instead of a 500.

- A payload the route's `.input()` schema refuses answers 400 on both doors (it was 500 on the `http()` source): `{ "error": "bad request", "code": "RC5065", "in": "body" | "headers", "issues": [{ "path", "message" }] }`, at most 20 issues with the rest counted in `truncated`. Issue messages are the schema's own text, sent verbatim, so a custom refinement message is client-facing. Only an RC5065 the dispatched route's own `.input()` raised maps: one raised by a route it calls through `direct()`, or thrown by a step, stays a 500.
- A refusal by the route's own `.authorize()` answers 401 or 403 on both doors (it was 500): an expired principal is `401 expired` with an `invalid_token` challenge, a role, predicate, subject or actor refusal is `403 insufficient_permissions`, and a missing scope is `403 insufficient_scope` naming the scopes, in the shape the ops tier check already answers, with its challenge. A missing principal answers 401 only where a credential could have supplied one (the ops door on an open tier with a validator). Only refusals `authorize()` itself raised about the principal the door admitted are mapped: a check of an identity the pipeline swapped in (`.authenticate()`, a delegation) stays a 500, and the same codes thrown by an adapter for an upstream failure stay a 500.

**Response shape change on the ops dispatch door.** Its RC5065 400 no longer carries `message`, which named the route and concatenated schema-author text; it carries `in` and `issues` instead. A client reading `message` off that response reads `issues`. The ops client and `craft exec` render the issues.

New exports: `isAuthorizationRefusal(err, { routeId, principal }?)` tells a refusal `authorize()` raised apart from the same code thrown elsewhere, and with a caller given, a refusal of that caller apart from one of an identity the pipeline swapped in, and `isInputValidationFailure(err.cause)` narrows an RC5065's cause to its structured `{ invalid: { in, issues, routeId } }` detail.

**`craft exec` exit code.** A dispatch the route's own `.authorize()` refuses now exits with `refused` (4) instead of `failed` (1), the same code a door-level refusal already used. A script branching on exit 1 for a refused call needs to check for 4. A remote dispatch refused by the route likewise surfaces as `RC5063` (refused) instead of `RC5064` (failed).
