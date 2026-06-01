---
title: Changelog
---

All notable changes to Routecraft. {% .lead %}

Routecraft is in active development -- APIs may change between minor versions.

---

## v0.6.0 {% badge color="gray" %}In development{% /badge %}

This section tracks changes landing on `main` since the v0.5.0 release. Release notes will be finalised when v0.6.0 is tagged. See the [0.5.x to 0.6.0 migration guide](/docs/migrating/0.5-to-0.6) for upgrade steps on the breaking AI surface changes below.

### AI & MCP {% badge color="red" %}Breaking{% /badge %}

- **Agent blocks replace skills** -- `AgentOptions.skills: string[]` and `agentPlugin({ skills })` are removed and replaced by a single `blocks: Blocks` record (`Record<string, BlockBody | false>`) that unifies skills, memory, identity, instructions, and any other system-context contribution. Each block has a `mode` (`"inject"` to always concatenate into the system prompt, `"progressive"` to surface as a synthetic loader tool the model invokes on demand) and a `lifetime` (`"dispatch"` to re-run the resolver every dispatch, `"context"` to evaluate once per `CraftContext` and cache). Resolvers receive `(exchange, context, events, client)`, where `client.forward(routeId, payload)` is the same callable route `.error()` handlers receive, so a block can derive content from another route without bespoke plumbing. The big semantic shift: progressive disclosure is now the default for `skills`, matching what Claude Code actually does -- the model picks which skills to load instead of paying full token cost for every skill on every dispatch. Use `mode: "inject"` to keep the legacy "concatenate every skill verbatim" behaviour. Set a block to `false` to remove a default inherited from `agentPlugin({ defaultOptions: { blocks } })`.
- **`skills({ source, mode?, lifetime? })` and `fromFile(path)` builders** -- `skills` keeps the 0.5 name but now returns a `Blocks` record you spread into `blocks: { ... }`. Reads the same markdown layout the deleted `skills(path)` loader did (flat `<name>.md` and nested `<name>/SKILL.md`, Claude Code frontmatter accepted) and defaults to progressive disclosure. `fromFile` returns a resolver that reads a UTF-8 file at resolution time.
- **Tag selectors on `tools()` removed** -- the `{ tagged }` and `{ tagged, from }` variants are gone, along with the `tags` override on `directTool`. Implicit extension of an agent's tool surface when a future fn is tagged with a matched value was a security footgun: an agent's tool list is a security boundary, and that boundary should be explicit. For the cases where enumeration is impractical, `tools()` now accepts a builder: `tools((catalog) => [...])` receives a `ToolsCatalog` snapshot (`{ fns, routes, mcp }`) and returns the same shape the array form accepts, putting any filter predicate in user code where it's visible. The implicit-extension behaviour is the same, but a `.filter()` at the call site is an obvious signal that the set is dynamic, not a declarative selector tucked into framework config.
- **Tool-call partitioning** -- synthetic block-loader invocations no longer appear on `AgentResult.toolCalls`. They surface on a new `AgentResult.blocksLoaded?: AgentBlockLoadSummary[]` so post-dispatch user-tool assertions stay clean. Loader calls also emit `route:<id>:agent:block:loaded` / `:agent:block:error` events instead of the `:agent:tool:*` family.
- **Loader tool naming reservation** -- the `_block_load_<name>` prefix is reserved. User tools (fn ids, direct route ids, block names) that start with `_block_` are rejected at construction or dispatch with `RC5026`.
- **Markdown agent loader: `skills:` frontmatter rejected** -- `agents("./agents")` no longer accepts a `skills:` field; YAML cannot express the function-form resolvers blocks may carry. Supply `blocks` via the per-agent overrides map handed to `agents()` instead.
- **Three new error codes** -- `RC5025` (block resolution failed), `RC5026` (block name collision / reserved prefix), `RC5027` (block misconfigured: invalid mode, missing description on a progressive block, etc).

### Adapters

- **HTTP source** {% badge color="red" %}Breaking{% /badge %} -- `http()` is now a two-sided adapter. `http({ path, method? })` exposes a route over HTTP via `defineConfig({ http: { port, host, auth } })`; Bun runtimes bind through `Bun.serve` and Node 22+ uses a zero-dependency `node:http` shim. Global auth accepts `jwt()` / `jwks()` bearer or `apiKey({...})`; per-route constraints reuse `.authorize({...})`, and a route opts out with `http({ public: true })`. Built-in `/health`, `/ready`, and `/openapi.json` endpoints register automatically (`openapi.expose` controls `/openapi.json` visibility). Request bodies are parsed by `Content-Type` (JSON / text / urlencoded / multipart), capped by `maxBodySize`. Adds error codes `RC5018` (request rejected) and `RC5019` (server bind failed). **Breaking:** the destination option type `HttpOptions<T>` is renamed `HttpClientOptions<T>` (the source uses `HttpServerOptions`); a type-only change with no runtime impact. See the [0.5.x to 0.6.0 migration guide](/docs/migrating/0.5-to-0.6#3-http-option-type-renamed-for-the-two-sided-adapter).

### Mail

- **Direct mail no longer misclassified as auto-forwarded** -- the delivering MX (Gmail / Google Workspace) stamps a single first-hop ARC set (`i=1`, `cv=none`) onto direct mail, so the presence of ARC headers is not evidence of forwarding. `analyzeHeaders` treated any ARC set as a forward, which downgraded DMARC-aligned direct mail to `unverified`. ARC is now only treated as forwarding evidence when the chain is validated (`cv=pass`/`cv=fail`) or spans more than one instance. Direct mail resolves to `direct` / `verified` via boundary DMARC. The mailing-list path (`List-Id`) and validated auto-forwards are unchanged.

### Docs site

- **Blog section at [/blog](/blog)** with an initial set of posts and a featured + latest grid layout. Markdoc-backed, theme-aware, with structured frontmatter for date, author, tags, and draft status.
- **Cheat sheet reference at [/cheat-sheet](/cheat-sheet)** -- searchable, theme-aware HTML page covering the full builder DSL, sources, destinations, operations, validation, error handling, events, MCP integration, CLI, and TUI. Print stylesheet produces a clean A4 PDF via `Cmd/Ctrl + P`.
- **Migration guide** -- new [0.5.x to 0.6.0 migration guide](/docs/migrating/0.5-to-0.6) covering the agent block primitive and tools function-form builder.

---

## [v0.5.0](https://github.com/routecraftjs/routecraft/releases/tag/v0.5.0) {% badge color="yellow" %}Pre-release{% /badge %}

*May 2026*

Several breaking changes across the core, AI, mail, telemetry, logger, and CLI surfaces. See the [0.4.x to 0.5.0 migration guide](/docs/migrating/0.4-to-0.5) for the full public-API diff and step-by-step upgrade notes.

### Core

- **Dual-mode wrapper pattern** -- `.error()` is the first wrapper in a new dual-mode design; route-level error handling is now a wrapper rather than a top-level method. Source-level parse errors now flow through the same handler.
- **Immutable Exchange** -- the `Exchange` is frozen and mutation is replaced with explicit copy-on-write. State is unified on `{ body, headers }`, with `principal`, `id`, and `logger` exposed as getters.
- **`.authorize()` route-entry guard** -- new principal accessor on `Exchange` and a route-only authorization validator. Replaces the previous `requirePrincipal` validator. The validator now also checks `principal.expiresAt` and raises `RC5020` when a long-running step has outlived the credential; pass `clockToleranceSec` to match the boundary-side verifier's tolerance.
- **Field-shaping helpers (`keep` and `mask`)** -- two transform helpers that shape a record (or array of records) field by field, both dropping into `.transform(...)`. `keep(rules)` is grant-based access control: it keeps fields the caller is granted (by role name or a `(record, principal)` predicate) and drops the rest, strict allowlist by default, and fails closed unless the principal is authentic. `mask(rules)` obfuscates field values regardless of the caller. Compose `keep` then `mask`.
- **Choice operation** -- new conditional routing primitive with `transform()` and `enrich()` available on branch builders. Core operations are shared between routes and branches via a `StepBuilderBase`.
- **Discovery metadata on the route builder** -- route id, description, and validation move from source options to the route builder itself.

### AI & MCP {% badge color="red" %}Breaking{% /badge %}

- **Agent runtime** -- tool-calling loop, streaming via `onEvent` and `onDelta`, agent destination, and per-binding tool description overrides.
- **`tools()` DSL** -- declarative tool registration, selection, and resolution.
- **Agent configuration overhaul** -- `agentPlugin.agents` is a record (no `defineAgent`), `defaultOptions` set context-level defaults, `system`/`user` accept string or function, and agent enhancements (`toolCalls`, `validate`, skills + agents loaders) narrow `FnHandlerContext`.
- **Config applier system** -- first-class AI plugin keys via a config applier hook.
- **MCP OAuth 2.1 server** -- OAuth 2.1 authentication provider with principal hierarchy, plus a general MCP HTTP auth surface and tool annotations.
- **MCP HTTP server identity and protected-resource metadata** -- new `mcpPlugin({ title, resource: { url, scopesSupported, documentationUrl } })` shape. Resource identity is now first-class on the plugin, orthogonal to the auth mode. Both validator-mode (`jwks()` / `jwt()`) and OAuth-proxy mode (`oauth()`) auto-mount `GET /.well-known/oauth-protected-resource` (RFC 9728) with the same JSON shape (including `bearer_methods_supported`) and append an absolute `resource_metadata="..."` URL to 401 `WWW-Authenticate` headers, so auto-discovering clients (Claude.ai connectors, MCP Inspector, `mcp-remote`) can locate the authorization server. `OAuthAuthOptions` is reduced to pure proxy mechanics. Field migration:
  - `oauth({ resourceIssuerUrl })` -> `mcpPlugin({ resource: { url } })`
  - `oauth({ scopesSupported })` -> `mcpPlugin({ resource: { scopesSupported } })`
  - `oauth({ serviceDocumentationUrl })` -> `mcpPlugin({ resource: { documentationUrl } })`
  - `oauth({ resourceName })` -> `mcpPlugin({ title })` (with `name` as the final fallback)
- **Plugin-level `userinfo` enrichment** -- post-verify principal enrichment on `mcpPlugin({ userinfo })`, orthogonal to the auth mode: works with `jwks()` / `jwt()` (validator mode), a custom `{ validator }`, and `oauth()`. Accepts `true` (auto-discover via OIDC Discovery), `string | URL` (explicit endpoint), or a custom function. The framework enforces the OIDC Core §5.3.2 `sub` invariant on URL / discovery modes, fails closed on any fetch / parse error, and memoises enrichment per token (SHA-256 hashed) with insertion-order eviction, in-flight coalescing, and TTL bound to `principal.expiresAt`. The raw userinfo response is surfaced on a separate `principal.userinfoClaims` field so `principal.claims` continues to mean "verified JWT payload." This enables the WorkOS AuthKit pattern (validator mode + identity hydration) that OAuth proxy mode could not serve. `oauth({})` no longer carries its own `userinfo`; it lives on the plugin, mirroring how `resource` was promoted off `oauth()`.
- **`OAuthValidatorAuthOptions.issuer`** -- `jwks()` and `jwt()` now surface the expected issuer on the returned options so `userinfo: true` discovery and RFC 9728 `authorization_servers` work without re-declaring the IdP.
- **`ClaimMappers.{email,name,roles}` removed** -- superseded by the `userinfo` enrichment slot. `ClaimMappers.{subject,clientId,scopes}` remain for token-level claim mapping.
- **Three new error codes** -- `RC5020` (token expired during processing), `RC5021` (principal enrichment failed), `RC5022` (userinfo `sub` invariant violated).
- **Isolated local tool registry** -- MCP local tools live in a dedicated registry separate from direct routes.

### Adapters

- **Adapter mocking** -- `mockAdapter` swaps any tagged adapter in tests; `file`, `csv`, `json`, `jsonl`, and `html` factories are tagged out of the box.
- **Direct adapter distinct input/output types** -- `direct<TIn, TOut>()` lets a route accept one body shape and emit a different one when the registered consumer's transformer changes the type.
- **Mail (IMAP)** -- the IMAP source is reliable across poll and re-evaluation workloads, with reconnect on transient fetch failures. `MailMessage` body is reshaped and a verify-sender option is available.
- **Optional peer loader everywhere** -- every dynamic optional-peer import goes through `loadOptionalPeer` and emits `RC5017` with a copy-pasteable install hint. The remaining bespoke `try/catch` sites (mail, jose, telemetry sqlite, several `@routecraft/ai` modules) have all been migrated.

### Telemetry {% badge color="red" %}Breaking{% /badge %}

- **Bun-only SQLite sink** -- the embedded telemetry SQLite sink now uses Bun's built-in `bun:sqlite`. `better-sqlite3` has been removed from the runtime, including from peer dependencies. Deployments that use the built-in sink must run under Bun (`engines.bun >= 1.1.0`); Node deployments that previously relied on `better-sqlite3` need to bring their own sink.

### Logger

- **stdout default** -- the logger writes to stdout instead of stderr.

### CLI & Tooling

- **Bun-only `craft` CLI** -- the published `craft` binary now requires Bun >= 1.1.0.
- **Bun monorepo** -- the monorepo migrates from pnpm to Bun for installs, scripts, and lockfile.
- **`create-routecraft` refactor** -- scaffolder library extracted with expanded test coverage.
- **`bun:test` everywhere** -- the internal test suite has fully migrated from vitest to `bun:test`. Vitest is retained only for the cross-runtime suite (where Node-only test seams still apply).

### Docs

- **Migration guide** -- new [0.4.x to 0.5.0 migration guide](/docs/migrating/0.4-to-0.5).
- **Canary docs at `/next/`** -- canary docs deploy to `/next/` on GitHub Pages alongside the latest stable build at the root.
- **Operator reference** -- `log` and `debug` operators documented; `map` and `schema` clarified.
- **Claude Code skills** -- Agent Skills for authoring Routecraft adapters and capabilities are bundled at the repo root.

---

## [v0.4.0](https://github.com/routecraftjs/routecraft/releases/tag/v0.4.0) {% badge color="yellow" %}Pre-release{% /badge %}

*March 2026*

### Adapters

- **Cron source** -- new adapter for scheduling capabilities with cron expressions.
- **JSONL adapter and chunked mode** -- read and write line-delimited JSON with chunked streaming for large files.
- **Modular adapter structure** -- adapters refactored into a consistent file layout with a unified DSL registration system.
- **Merged options** -- `cron` and `direct` adapters now support merged options across config and route.

### AI & MCP

- **stdio MCP client** -- spawn and manage stdio-based MCP servers with a unified tool registry.
- **Bearer token authentication** -- secure MCP HTTP transport with bearer tokens.

### Framework

- **Terminal UI** -- new TUI for inspecting running contexts and routes.
- **Reduced public API surface** -- internal-only exports are no longer published, tightening the long-term API contract.

### TypeScript

- **Declaration-merging registries** -- compile-time adapter safety via type registries that adapter packages can extend.

### Testing

- **Spy adapter assertions** -- richer assertion helpers in `@routecraft/testing` for spying on capability output.

### Docs

- **Light mode** -- hero section and syntax highlighting now respect light mode.
- **Copy-to-clipboard** -- code blocks gain a copy button.
- **Community resources** -- new section linking external content and contributors.
- **Dark-mode contrast** -- prose strong text is more readable on dark backgrounds.

---

## [v0.3.0](https://github.com/routecraftjs/routecraft/releases/tag/v0.3.0) {% badge color="yellow" %}Pre-release{% /badge %}

*March 2026*

### Adapters

- **Agent, embedding, and LLM adapters** -- new adapters for integrating AI agent workflows, embedding models, and large language models directly into capabilities.
- **HTTP adapter** -- first-class HTTP source and destination support.
- **Browser and HTML adapters** -- interact with web pages and parse HTML content.
- **JSON adapter** -- dedicated adapter for JSON data sources.
- **Grouping adapter** -- group messages by key before forwarding.
- **File adapter** -- read and write text, JSON, and CSV files with a unified adapter.

### AI & MCP

- **`@routecraft/testing` package** -- expanded testing utilities with MCP integration support.
- **Consistent adapter pattern** -- all adapters now follow a unified pattern for configuration, lifecycle, and error handling.

### Events

- **Hierarchical event model** -- new operation-level events with parent-child relationships, enabling fine-grained observability across capability execution.

### TypeScript

- **TypeScript support** -- author capabilities in TypeScript with full type inference and compile-time validation.

### Docs

- **Capability-centric terminology** -- all documentation renamed from "routes" to "capabilities" for consistency.
- **Advanced guides** -- new documentation covering advanced patterns, capability composition, and adapter authoring.

---

## [v0.2.0](https://github.com/routecraftjs/routecraft/releases/tag/v0.2.0) {% badge color="yellow" %}Pre-release{% /badge %}

*February 2026*

### AI & MCP

- **New `@routecraft/ai` package** -- MCP integration with full schema validation via Zod. Expose any capability as an MCP tool for Claude Desktop, Cursor, and other MCP clients.
- **MCP server support** -- run your capabilities as an MCP server with a single CLI command.
- **MCP client support** -- call external MCP servers from within a capability using the `mcpPlugin`.

### Adapters & Operations

- **`direct` adapter validation** -- improved validation and error messages for inter-capability communication.
- **`aggregate` operation** -- default aggregator now flattens arrays and combines scalars automatically.
- **`batch` operation** -- new ESLint rule (`batch-before-from`) enforces correct batch positioning at the route level.
- **`pseudo` adapter** -- new adapter for stubbing sources and destinations in tests and local development.

### Framework

- **Cross-instance identity** -- supports multiple package copies and `npx`-based installs resolving to the same context identity.
- **Logging configuration** -- enhanced logging setup with more control over levels and output format.

---

## [v0.1.1](https://github.com/routecraftjs/routecraft/releases/tag/v0.1.1) {% badge color="yellow" %}Pre-release{% /badge %}

*November 2025*

Quality-of-life improvements.

### Adapters

- **Custom log messages** -- adapters and operations now support custom log message overrides.
- **Fetch adapter** -- automatically parses JSON responses, no manual parsing needed.

### Framework

- **`.env.local` support** -- environment variables in `.env.local` are loaded automatically alongside `.env`.

### Tooling

- **`create-routecraft`** -- project scaffolding now supports example selection and template file configuration.
- **CodeSandbox** -- added online playground link in the installation docs for zero-install experimentation.

---

## [v0.1.0](https://github.com/routecraftjs/routecraft/releases/tag/v0.1.0) {% badge color="yellow" %}Pre-release{% /badge %}

*October 2025*

Initial release.

### Framework

- **Fluent DSL** -- `craft().from().to()` builder syntax for authoring capabilities.
- **Core operations** -- `transform`, `filter`, `enrich`, `aggregate`, `split`, `validate`, `tap`, `process`, `header`, and more.
- **Backpressure** -- simple and batch consumers with built-in backpressure support.
- **CraftContext** -- route lifecycle management with hot reload in development.
- **Error handling** -- structured RC error codes with Pino logging.

### Adapters

- **Built-in adapters** -- `simple`, `timer`, `direct`, `log`, `noop`, `fetch`.

### Tooling

- **CLI** -- `craft run` and `craft watch` commands.
- **`create-routecraft`** -- project scaffolding tool.
- **ESLint plugin** -- `require-named-route` rule out of the box.
- **Test utilities** -- `@routecraft/testing` package with `testContext` and `spy` adapter.