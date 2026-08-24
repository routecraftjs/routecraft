---
"@routecraft/routecraft": minor
"@routecraft/cli": minor
---

The management API on the ops server, plus `craft exec` and `craft ops` (#209, #194, #644).

A running instance can now be driven over HTTP, locally or remotely, and two CLI command families are clients of that one surface.

## The API

Three resources on the ops mount, under `/ops`. Dispatching creates an exchange, so the exchange is a sub-resource of the route it runs on rather than a verb of its own.

| Method and path | Tier | What |
| --- | --- | --- |
| `GET /ops/routes` | introspection | List routes, filtered and paginated |
| `GET /ops/routes/{id}` | introspection | Describe one route |
| `POST /ops/routes/{id}/exchanges` | dispatch | Dispatch work and return the outcome |

The handlers are transport-agnostic and the mount is a thin door over them, so the console's control API can grow over the same handlers later without protocol rework.

**Secure by default, and loudly so.** Every tier is disabled unless named, and a disabled tier answers **404 rather than 403**: an unconfigured instance discloses neither its route inventory nor that a management surface exists. Each tier takes `false` (the default), `true` (open), or a scope string the caller's principal must carry. `ops:introspection` and `ops:dispatch` are the documented names, `ops:operations` is reserved, and dispatch is always its own scope so a dashboard token that reads the inventory cannot also run work.

Authentication is ordinary mount auth: the ops mount's own `auth`, else the named server's, per the existing inheritance rules. Nothing bespoke. A tier naming a scope with no validator in scope fails the boot rather than guessing, since admitting everyone and refusing everyone are opposites and neither is what was written.

**No bypass and no synthetic operator principal.** A dispatch runs the full pre-from chain and `.authorize()` sees exactly the principal the validator minted, so an operator dispatch is indistinguishable from any other authenticated caller.

**Collections page for real.** Every collection response is `{ items, nextCursor }`, never a bare array, with keyset cursors matching the suspension store's idiom. A cursor is valid only for the filter that produced it, and a malformed `limit` is refused rather than clamped: a caller silently handed a bounded page cannot tell a truncated answer from a complete one.

**A park is an outcome.** A dispatch against a suspendable route answers 202 with the standard `Suspended` acknowledgment. A drop is reported separately from a failure, because a filter saying no and a step breaking need different answers.

## The clients

`craft exec <route> [--field=value ...]` dispatches and prints the result; input can also arrive as JSON on stdin. `craft ops health | ready | routes [id] | indicators [name]` reads the instance's own state.

Both resolve one **personal settings file** (`.routecraft/settings.yaml`, project-local then global), overridden by `CRAFT_URL` / `CRAFT_TOKEN` / `CRAFT_FORMAT` and then by flags. It is the person's file, never app configuration. A connection failure names both the address used and which source supplied it. Output is `pretty` by default, with `json` and `raw`.

The CLI groups by operator task rather than by URL prefix: `craft ops health` reads `/health/**`, which is deliberately not under `/ops`, and both are stated once in the docs so nobody "fixes" the apparent inconsistency in either direction. Health never walls but returns more when authenticated, so the clients present a credential whenever the settings provide one and say which view is being shown rather than rendering a status with no reason.

## Breaking notes

**`ops.auth: false` is no longer refused.** It previously threw as a no-op; it now carries the server plugin's meaning unchanged, so no validator is effective for the mount. Consequences: the `health.details` gate closes, and a scope-gated tier has nothing to check against and fails the boot. Nothing that worked before stops working; what changes is that a spelling which used to be an error is now meaningful.

**`apiKey()` gains `scopes`**, applied to the principal minted by the static `keys` allowlist, so a deployment without an identity provider can satisfy a scope check. It is refused alongside `verify`, where the returned principal already says what it carries.

New error codes: `RC5059` (a refused paging argument) and `RC5060` (a dispatch against a route with no `direct()` door).

`missingCredentialResponse` moved into the shared HTTP response module, and the `~standard.jsonSchema` reader was extracted out of the suspension descriptor so both callers share one implementation. The JSON Schema dialect is passed explicitly at each call site, so a display choice in the management API can never move a stored continuation hash.
