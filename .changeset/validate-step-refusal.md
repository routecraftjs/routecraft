---
"@routecraft/routecraft": minor
---

A route's own `.validate()` step can refuse the caller with a reason. A validator that returns or throws `refuse(reason, { kind })` fails the run with `RC5068` bound to the route, exactly as a plugin's validate hook does, so a door that dispatched the route (the `http()` source, the ops dispatch mount, an MCP tool call, the ACP mount) answers with the kind and the reason instead of a bare code or a 500. Until now a returned refusal was handed on as the body and the route carried on, and a thrown one was the instance's failure. A plain throw keeps meaning the instance failed, and a refusal raised inside a nested `direct()` call stays that call's. The validator types admit a `Refusal` beside the body, so admitting a refusal does not widen the body type after `.validate()`.
