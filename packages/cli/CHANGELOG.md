# @routecraft/cli

## 0.7.0

### Minor Changes

- [#645](https://github.com/routecraftjs/routecraft/pull/645) [`602787a`](https://github.com/routecraftjs/routecraft/commit/602787a60494f73cdd6d9d550c293ea0e6fd3dfa) Thanks [@ex0b1t](https://github.com/ex0b1t)! - The management API on the ops server, plus `craft exec` and `craft ops` ([#209](https://github.com/routecraftjs/routecraft/issues/209), [#194](https://github.com/routecraftjs/routecraft/issues/194), [#644](https://github.com/routecraftjs/routecraft/issues/644)).

  A running instance can now be driven over HTTP, locally or remotely, and two CLI command families are clients of that one surface.

  ## The API

  Three resources on the ops mount, under `/ops`. Dispatching creates an exchange, so the exchange is a sub-resource of the route it runs on rather than a verb of its own.

  | Method and path                   | Tier          | What                                 |
  | --------------------------------- | ------------- | ------------------------------------ |
  | `GET /ops/routes`                 | introspection | List routes, filtered and paginated  |
  | `GET /ops/routes/{id}`            | introspection | Describe one route                   |
  | `POST /ops/routes/{id}/exchanges` | dispatch      | Dispatch work and return the outcome |

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

- [#718](https://github.com/routecraftjs/routecraft/pull/718) [`b7255b0`](https://github.com/routecraftjs/routecraft/commit/b7255b0d69a0dcd1b4b33965a9391d287f847bca) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `craft chat <route> --session <id>` (the 0.7.0 slice of [#599](https://github.com/routecraftjs/routecraft/issues/599)): a conversation with an agent session on a running instance, one message per line. Every line is a dispatch of `{ session, message }` to the route fronting the agent through the management door, and the reply is printed; a queued message is said to be queued. The conversation lives in the instance's store, so the loop can be killed and reattached with the same session id. Exit codes are `craft exec`'s. This release ships the print mode only: `--print` (`-p`) runs the line loop with no interface, piped input implies it, and the flagless form on a terminal refuses with the usage exit code until the interactive mode exists, so a script written today keeps its behaviour when it does.

- [#586](https://github.com/routecraftjs/routecraft/pull/586) [`a9b355c`](https://github.com/routecraftjs/routecraft/commit/a9b355c66ebf7572e46705626bf2909664b7da50) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `craft start`, the convention-based project runtime ([#131](https://github.com/routecraftjs/routecraft/issues/131)), and drop-in compatibility for Claude Code agent files ([#340](https://github.com/routecraftjs/routecraft/issues/340)).

  **`craft start [dir]`** boots a whole project from its folder layout instead of a hand-written barrel: `craft.config.ts`, then `plugins/`, then any folder an ecosystem package has claimed, then `capabilities/`. Both the root-level and `src/`-nested layouts work, and a folder that is absent is skipped. A directory holding `route.ts` is one capability and is not descended into, so colocated tests, fixtures and private helpers are never imported. A `plugins/` module that default-exports a factory is an error naming the file, because a factory needs arguments the runtime cannot invent.

  **`registerProjectDiscoverer`** lets a package claim a convention folder and turn it into a config fragment, which is how `agents/` and `skills/` get their meaning without the CLI ever depending on `@routecraft/ai`. A discoverer receives a context object (the folder, the content root, the project root, and the configuration accumulated so far) and declares its ordering as `after: ["skills"]` rather than a magic number. Cycles are an error; a dependency on a folder nobody registered is satisfied. A claimed folder present with no discoverer registered fails loudly, naming the erased type-import case, since that is the one the author will be staring at.

  Skills compose house folder, then frontmatter `skills:` refs in declared order, then the bundle's own folder, most specific winning and every source named in the startup log. Refs are local paths or `npm:` package refs resolved against installed packages only. Precedence is code wins, convention fills the gaps, applied per field: an agent declared in `craft.config.ts` keeps every field it set and discovery contributes only the skill set it left unset.

  `--once` shuts down after the first exchange reaches a terminal outcome, and pairs with `--timeout <ms>` so a project that produces nothing reports instead of hanging.

  **Claude Code agent files** load without edits: unknown frontmatter is ignored with a warning, `tools` and `disallowedTools` accept Claude's comma-separated string, `model` accepts the `opus` / `sonnet` / `haiku` aliases and `inherit`, and a reference to a Claude built-in this runtime does not provide is dropped with a warning rather than failing the load. `disallowedTools` without `tools` is rejected at load: a per-agent list replaces the context default rather than narrowing it, so a deny list alone cannot be honoured and silently inheriting the denied tools would be the worst reading of the file.

  New error code `AI1004` for a `skills:` ref that does not resolve.

- [#679](https://github.com/routecraftjs/routecraft/pull/679) [`3b48ba5`](https://github.com/routecraftjs/routecraft/commit/3b48ba52bfe8bc91cf77de8023e080e534b5eca2) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Http surfaces become discoverable protected resources, and the CLI reads the challenge ([#669](https://github.com/routecraftjs/routecraft/issues/669)).

  Routecraft verifies; issuers issue. This release makes a refused caller able to find out who issues, on every http surface rather than only MCP.

  ## Server
  - The RFC 9728 protected-resource metadata builder and the CORS policy engine move from `@routecraft/ai` into core (`buildProtectedResourceMetadata`, `HttpCorsOptions`, exported from the package root). MCP consumes the shared implementation with unchanged behaviour on its own claimed paths; `McpCorsOptions` and `McpCorsOriginResolver` remain as aliases.
  - Every http server serves `/.well-known/oauth-protected-resource`, with RFC 9728 path-suffixed documents mirroring any path no mount claims exactly. Documents are sourced from the owning mount's effective validator (issuer from `jwt()` / `jwks()`) and declared scopes; the ops mount declares its scope-gated tier values as `scopes_supported`. A bare `{ validator }` with no issuer yields an honest minimal document.
  - Every bearer 401 (shared middleware, the synthesized missing-credential response on http and ops) carries a `resource_metadata` hint in its `WWW-Authenticate` challenge; the ops `insufficient_scope` 403 carries it alongside the `scope` it already named.

  ## CLI
  - `craft exec` and `craft ops` parse `WWW-Authenticate` on a refusal, follow the `resource_metadata` hint (best effort, 5s timeout), and extend the refusal with which scope is required, who issues acceptable tokens, and how to supply a credential (`--token`, `CRAFT_TOKEN`, settings file).
  - `.routecraft/settings.yml` is accepted beside `settings.yaml`, resolved independently per location; a location carrying both spellings refuses with both paths named.

  ## Docs

  The credential ladder as recipes on securing-capabilities and the ops reference: no auth, a static key compared with `timingSafeStringEqual`, a self-signed JWT via `jwt({ secret })`, and a real IdP via `jwks()`. The static-key recipe is compiled and run verbatim by the test suite.

### Patch Changes

- [#676](https://github.com/routecraftjs/routecraft/pull/676) [`567c922`](https://github.com/routecraftjs/routecraft/commit/567c9221fc3ea6fd4eb334836c2d1cd600daa0fa) Thanks [@ex0b1t](https://github.com/ex0b1t)! - A failed dispatch now shows the framework error code the instance returned.

  An error body carrying no `message` was reported only as "The instance answered 500", which made a route that refused the caller's own credential (`RC5038`) indistinguishable from one that crashed. The code belongs to a bounded, documented vocabulary and is safe to show, so it is shown, with a pointer to the reference page that explains it.

- [#676](https://github.com/routecraftjs/routecraft/pull/676) [`567c922`](https://github.com/routecraftjs/routecraft/commit/567c9221fc3ea6fd4eb334836c2d1cd600daa0fa) Thanks [@ex0b1t](https://github.com/ex0b1t)! - A blank flag or environment value no longer counts as supplied when resolving settings.

  `--url "$CRAFT_URL"` with the variable unset expands to an empty string, and an exported `CRAFT_URL=` arrives the same way. Both used to win the precedence they never earned and override the settings file with nothing, so the CLI addressed an empty URL, or presented a bearer with nothing after it and reported that the credential was rejected. The value is trimmed rather than merely tested, so one pasted with a trailing newline is not refused with nothing to suggest the whitespace is why.

  A blank written into a settings file is unchanged and still refused: that is the one source a blank can only reach by hand, and explaining it is more use than silently falling back.

- Updated dependencies [[`b7255b0`](https://github.com/routecraftjs/routecraft/commit/b7255b0d69a0dcd1b4b33965a9391d287f847bca), [`044917c`](https://github.com/routecraftjs/routecraft/commit/044917c02f7a51027fc0133135d15ece310a44b1), [`8aa360e`](https://github.com/routecraftjs/routecraft/commit/8aa360e34a67a0affb90bf6283405eb65fc5d51f), [`602787a`](https://github.com/routecraftjs/routecraft/commit/602787a60494f73cdd6d9d550c293ea0e6fd3dfa), [`489fb85`](https://github.com/routecraftjs/routecraft/commit/489fb85ea8479a36a4a43ec19288884e42c81c5c), [`a9b355c`](https://github.com/routecraftjs/routecraft/commit/a9b355c66ebf7572e46705626bf2909664b7da50), [`67189a4`](https://github.com/routecraftjs/routecraft/commit/67189a4036ec9462110b138996c517d89eb80262), [`dbf4610`](https://github.com/routecraftjs/routecraft/commit/dbf46104fe102e6d0a3f91d3dddc82193df45310), [`567c922`](https://github.com/routecraftjs/routecraft/commit/567c9221fc3ea6fd4eb334836c2d1cd600daa0fa), [`8f01cf8`](https://github.com/routecraftjs/routecraft/commit/8f01cf8802e17217eb045116ed248fc22a3d09e5), [`07e9b4c`](https://github.com/routecraftjs/routecraft/commit/07e9b4c118ad509d13b3e07dccdca488481f9788), [`72073ae`](https://github.com/routecraftjs/routecraft/commit/72073ae5cebb5d3d01c5bd6a9cf760c298469835), [`3cd2c9f`](https://github.com/routecraftjs/routecraft/commit/3cd2c9f19b0d6d6f22763461662c1eab1991d8d5), [`261d9a4`](https://github.com/routecraftjs/routecraft/commit/261d9a45659ae32ff8e06f5ed2d523983e48dac2), [`d738d05`](https://github.com/routecraftjs/routecraft/commit/d738d05b946292bb4ebb78984507877f8ed3d259), [`a97f6b2`](https://github.com/routecraftjs/routecraft/commit/a97f6b260f6143c2139b15a596c2074920403a14), [`dbf4610`](https://github.com/routecraftjs/routecraft/commit/dbf46104fe102e6d0a3f91d3dddc82193df45310), [`3b48ba5`](https://github.com/routecraftjs/routecraft/commit/3b48ba52bfe8bc91cf77de8023e080e534b5eca2), [`3b48ba5`](https://github.com/routecraftjs/routecraft/commit/3b48ba52bfe8bc91cf77de8023e080e534b5eca2), [`fbf9bfc`](https://github.com/routecraftjs/routecraft/commit/fbf9bfc56507eb492ce4ebf5aaac3ac5715b8c02), [`fbf9bfc`](https://github.com/routecraftjs/routecraft/commit/fbf9bfc56507eb492ce4ebf5aaac3ac5715b8c02), [`443b160`](https://github.com/routecraftjs/routecraft/commit/443b160380cabbea7d880fb3899c8265e5a43bb5), [`a18bee7`](https://github.com/routecraftjs/routecraft/commit/a18bee75b821c63bd53041d0e353b59bc476ad29), [`cf46f07`](https://github.com/routecraftjs/routecraft/commit/cf46f0707913ff4902ea45e71066ce5500f65939), [`50ef8c3`](https://github.com/routecraftjs/routecraft/commit/50ef8c337f98a642641b2a6c3d83fb17c1e1741b), [`2432c0e`](https://github.com/routecraftjs/routecraft/commit/2432c0e5bccf1bdb73399439f2229beea910ee22), [`67189a4`](https://github.com/routecraftjs/routecraft/commit/67189a4036ec9462110b138996c517d89eb80262), [`67189a4`](https://github.com/routecraftjs/routecraft/commit/67189a4036ec9462110b138996c517d89eb80262), [`67189a4`](https://github.com/routecraftjs/routecraft/commit/67189a4036ec9462110b138996c517d89eb80262), [`3f64e8c`](https://github.com/routecraftjs/routecraft/commit/3f64e8c71452b0b4357a920ab2f4073d15e1f9f0), [`0f2879a`](https://github.com/routecraftjs/routecraft/commit/0f2879a3264bd05d406c3c89de57c8ee0bc0fb48), [`1ed5edf`](https://github.com/routecraftjs/routecraft/commit/1ed5edfd7c6023c58d5c87829b362744d65e3c32), [`567c922`](https://github.com/routecraftjs/routecraft/commit/567c9221fc3ea6fd4eb334836c2d1cd600daa0fa), [`8a45022`](https://github.com/routecraftjs/routecraft/commit/8a4502283a6b6c5a377205cd4a0ddbf27acecd83), [`bb48cce`](https://github.com/routecraftjs/routecraft/commit/bb48cceb13dddfd1a8fdf2528ee8e4e6ba332b68), [`2432c0e`](https://github.com/routecraftjs/routecraft/commit/2432c0e5bccf1bdb73399439f2229beea910ee22), [`5a9758c`](https://github.com/routecraftjs/routecraft/commit/5a9758cadb2c0539f167d6fbee6f3f963f84fee8), [`5a9758c`](https://github.com/routecraftjs/routecraft/commit/5a9758cadb2c0539f167d6fbee6f3f963f84fee8), [`b97f82c`](https://github.com/routecraftjs/routecraft/commit/b97f82c3cabe900a8fee2bc13544b20fdbc2dfdd), [`cc652b9`](https://github.com/routecraftjs/routecraft/commit/cc652b909f208baad8fec1f5740a8cbed5ce9208)]:
  - @routecraft/routecraft@0.7.0

## 0.6.0

### Patch Changes

- [#560](https://github.com/routecraftjs/routecraft/pull/560) [`4c7cbfa`](https://github.com/routecraftjs/routecraft/commit/4c7cbfab2146dbc9625649b40ffe9d6b72e734b3) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Raise the runtime dependency floors for `@opentelemetry/sdk-trace-base` to `^2.10.0`, `fast-xml-parser` to `^5.10.1`, `jose` to `^6.2.8` and `mailparser` to `^3.9.15`. The `imapflow` floor deliberately stays at `^1.4.7`: 1.6.6 is inside the dependency cooldown window and the mail source's reconnect behaviour changed in this same release, so consumers are not forced onto it.

- [#474](https://github.com/routecraftjs/routecraft/pull/474) [`545f433`](https://github.com/routecraftjs/routecraft/commit/545f433c69234c745d8a6a3d3a075eada22d60ab) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Add the `xml` adapter: read, write, and transform XML through a plain-object representation, mirroring the `json` and `csv` codec adapters. Works as a transformer (parse an XML string in the body), a source (read and parse a file), a returning destination (`mode: 'read'`), a write destination, and a `delete` destination. Malformed XML surfaces as an observable per-exchange `RC5016` failure honouring `onParseError` (`fail` / `abort` / `drop`). `fast-xml-parser` is loaded as an optional peer dependency through `loadOptionalPeer` (missing install reports `RC5017` with an install hint) and bundled by the CLI.

- Updated dependencies [[`53ee88c`](https://github.com/routecraftjs/routecraft/commit/53ee88c9ae3f3eb89d2d673db8ac039de9b062ec), [`0cfd01c`](https://github.com/routecraftjs/routecraft/commit/0cfd01c5bacca05405bd093a3f1183a9249adff6), [`9d9d7f0`](https://github.com/routecraftjs/routecraft/commit/9d9d7f0e4d61717d12760c0aff50ae4341ac5ab0), [`6722d4a`](https://github.com/routecraftjs/routecraft/commit/6722d4a75de6c7d08ec438d97c1bc07ce780df98), [`f43d5ea`](https://github.com/routecraftjs/routecraft/commit/f43d5ea3797c38e64df3210953999770e1056a5f), [`faa5331`](https://github.com/routecraftjs/routecraft/commit/faa5331f3aae3da6ed980c85fa35d2beb147ee72), [`db38127`](https://github.com/routecraftjs/routecraft/commit/db3812755bdf36bc15ef284a479b8288deaababd), [`23257a0`](https://github.com/routecraftjs/routecraft/commit/23257a04d3086eb9fdcdc651764948c224f855ae), [`faa5331`](https://github.com/routecraftjs/routecraft/commit/faa5331f3aae3da6ed980c85fa35d2beb147ee72), [`10dc341`](https://github.com/routecraftjs/routecraft/commit/10dc3413ea61fe4a67673debf8ecfdaf9a0eb23c), [`f43d5ea`](https://github.com/routecraftjs/routecraft/commit/f43d5ea3797c38e64df3210953999770e1056a5f), [`31bae7f`](https://github.com/routecraftjs/routecraft/commit/31bae7f1ab11e1ec302bc98b7a14ea01c84d463e), [`a051bc0`](https://github.com/routecraftjs/routecraft/commit/a051bc07ef3536ed90c8427cf28c4323af1280e0), [`f2b6e9f`](https://github.com/routecraftjs/routecraft/commit/f2b6e9f9ab533bf643a30ab99c92bc8662b66c92), [`fd5c640`](https://github.com/routecraftjs/routecraft/commit/fd5c64039dd55f04f8e229021f2911a23f22ad8a), [`31bae7f`](https://github.com/routecraftjs/routecraft/commit/31bae7f1ab11e1ec302bc98b7a14ea01c84d463e), [`6722d4a`](https://github.com/routecraftjs/routecraft/commit/6722d4a75de6c7d08ec438d97c1bc07ce780df98), [`f1896a5`](https://github.com/routecraftjs/routecraft/commit/f1896a542ae1a3bc4de76f5650ef0ab728ba6908), [`f43d5ea`](https://github.com/routecraftjs/routecraft/commit/f43d5ea3797c38e64df3210953999770e1056a5f), [`828e7c9`](https://github.com/routecraftjs/routecraft/commit/828e7c957637c896aca35073768fd0ec72ce13b8), [`545f433`](https://github.com/routecraftjs/routecraft/commit/545f433c69234c745d8a6a3d3a075eada22d60ab), [`4c7cbfa`](https://github.com/routecraftjs/routecraft/commit/4c7cbfab2146dbc9625649b40ffe9d6b72e734b3)]:
  - @routecraft/routecraft@0.6.0
