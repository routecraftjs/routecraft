---
title: Changelog
---

All notable changes to Routecraft. {% .lead %}

Routecraft is in active development -- APIs may change between minor versions.

---

## v0.6.0 {% badge color="gray" %}In development{% /badge %}

This section tracks changes landing on `main` since the v0.5.0 release. Release notes will be finalised when v0.6.0 is tagged. See the [0.5.x to 0.6.0 migration guide](/docs/migrating/0.5-to-0.6) for upgrade steps on the breaking AI surface changes below.

### AI & MCP {% badge color="red" %}Breaking{% /badge %}

- **Agent blocks replace skills** -- `AgentOptions.skills` and `agentPlugin({ skills })` are removed in favour of a `blocks` record that unifies skills, memory, identity, and instructions, with progressive disclosure now the default. See the [migration guide](/docs/migrating/0.5-to-0.6).
- **`skills({ source })` and `fromFile(path)` builders** -- `skills` now returns a `blocks` record to spread into `blocks: { ... }`; `fromFile` reads a UTF-8 file at resolution time.
- **Tag selectors on `tools()` removed** -- the `{ tagged }` / `{ tagged, from }` variants and the `tags` override on `directTool` are gone. Use the new `tools((catalog) => [...])` builder form for dynamic selection.
- **Block-loader calls partitioned out of `toolCalls`** -- progressive loads surface on `AgentResult.blocksLoaded` and emit `agent:block:*` events instead of `agent:tool:*`.
- **`skills:` frontmatter on `agents()` rejected** -- supply `blocks` through the per-agent overrides map instead.
- **New error codes `RC5025`-`RC5027`** -- block resolution failure, name collision / reserved `_block_` prefix, and block misconfiguration.

### Adapters

- **HTTP source** {% badge color="red" %}Breaking{% /badge %} -- `http()` is now a two-sided adapter. `http({ path, method? })` exposes a route over HTTP via `defineConfig({ http: { port, host, auth } })`; Bun runtimes bind through `Bun.serve` and Node 22+ uses a zero-dependency `node:http` shim. Global auth accepts `jwt()` / `jwks()` bearer or `apiKey({...})`; per-route constraints reuse `.authorize({...})`. Per-route auth handling has three modes via `http({ auth: "required" | "optional" | "skip" })`: secure-by-default `"required"`, `"optional"` (admit anonymously, attach principal when a valid credential is present, reject invalid credentials), and `"skip"` (bypass the middleware entirely for truly identity-free routes like RSS or probes). Built-in `/health`, `/ready`, and `/openapi.json` endpoints register automatically. Each is configured via the uniform `http: { builtins: { health, ready, openapi } }` block with `{ enabled, requireAuth }` per endpoint (Spring-Actuator-inspired). Defaults gate the `routes` count on `/ready` from anonymous callers (`requireAuth: true`) and keep `/openapi.json` public (`requireAuth: false`, matching the Stripe / GitHub / Twilio convention). Request bodies are parsed by `Content-Type` (JSON / text / urlencoded / multipart), capped by `maxBodySize`. Adds error codes `RC5018` (request rejected) and `RC5019` (server bind failed). **Breaking:** the destination option type `HttpOptions<T>` is renamed `HttpClientOptions<T>` (the source uses `HttpServerOptions`); a type-only change with no runtime impact. See the [0.5.x to 0.6.0 migration guide](/docs/migrating/0.5-to-0.6#3-http-option-type-renamed-for-the-two-sided-adapter).

### Mail

- **Direct mail no longer misclassified as auto-forwarded** -- a single first-hop ARC seal (`i=1`, `cv=none`) added by the delivering MX is no longer read as forwarding, so DMARC-aligned direct mail stays `direct` / `verified` instead of `unverified`. Mailing-list and validated-forward classification are unchanged.

### Docs site

- **Blog at [/blog](/blog)** -- Markdoc-backed posts with a featured + latest layout.
- **Cheat sheet at [/cheat-sheet](/cheat-sheet)** -- searchable single-page DSL reference, print-to-PDF friendly.
- **[0.5.x to 0.6.0 migration guide](/docs/migrating/0.5-to-0.6)** -- upgrade steps for the breaking AI changes above.

---

## [v0.5.0](https://github.com/routecraftjs/routecraft/releases/tag/v0.5.0) {% badge color="yellow" %}Pre-release{% /badge %}

*May 2026*

Several breaking changes across the core, AI, mail, telemetry, logger, and CLI surfaces. See the [0.4.x to 0.5.0 migration guide](/docs/migrating/0.4-to-0.5) for the full public-API diff and step-by-step upgrade notes.

### Core

- **Dual-mode wrapper pattern** -- `.error()` becomes a route-level wrapper rather than a top-level method, and source-level parse errors flow through the same handler.
- **Immutable Exchange** -- the `Exchange` is frozen with explicit copy-on-write; state is unified on `{ body, headers }`.
- **`.authorize()` route-entry guard** -- a route-only authorization validator that replaces `requirePrincipal` and raises `RC5020` when a credential expires mid-run.
- **Field-shaping helpers `keep` and `mask`** -- two `.transform()` helpers: `keep` is grant-based, fail-closed allowlisting; `mask` obfuscates values regardless of caller.
- **Choice operation** -- a conditional routing primitive with `transform()` and `enrich()` on branch builders.
- **Discovery metadata on the route builder** -- route id, description, and validation move from source options to the builder.

### AI & MCP {% badge color="red" %}Breaking{% /badge %}

- **Agent runtime** -- tool-calling loop, streaming via `onEvent` / `onDelta`, agent destination, and per-binding tool description overrides.
- **`tools()` DSL** -- declarative tool registration, selection, and resolution.
- **Agent configuration overhaul** -- `agentPlugin.agents` is a record (no `defineAgent`), and `system` / `user` accept a string or function. See the [migration guide](/docs/migrating/0.4-to-0.5).
- **MCP OAuth 2.1 server** -- OAuth 2.1 provider with principal hierarchy, plus a general MCP HTTP auth surface and tool annotations.
- **MCP protected-resource metadata** -- resource identity moves to `mcpPlugin({ title, resource })`; both validator and OAuth-proxy modes auto-mount RFC 9728 metadata. Field-by-field moves are in the [migration guide](/docs/migrating/0.4-to-0.5).
- **Plugin-level `userinfo` enrichment** -- `mcpPlugin({ userinfo })` hydrates the principal after verification, enabling the WorkOS AuthKit pattern. Lives on the plugin, orthogonal to the auth mode.
- **`ClaimMappers.{email,name,roles}` removed** -- superseded by `userinfo` enrichment; the token-level mappers remain.
- **New error codes `RC5020`-`RC5022`** -- token expired during processing, principal enrichment failed, and userinfo `sub` invariant violated.

### Adapters

- **Adapter mocking** -- `mockAdapter` swaps any tagged adapter in tests; the `file`, `csv`, `json`, `jsonl`, and `html` factories are tagged out of the box.
- **`direct<TIn, TOut>()` distinct types** -- a route can accept one body shape and emit another.
- **Mail (IMAP) reliability** -- reconnect on transient fetch failures, a reshaped `MailMessage` body, and a verify-sender option.
- **Optional peer loader everywhere** -- every optional-peer import now routes through `loadOptionalPeer` and emits `RC5017` with an install hint.

### Telemetry {% badge color="red" %}Breaking{% /badge %}

- **Bun-only SQLite sink** -- the built-in telemetry sink uses `bun:sqlite`; `better-sqlite3` is removed. Node deployments that relied on it must bring their own sink.

### Logger

- **stdout default** -- the logger writes to stdout instead of stderr.

### CLI & Tooling

- **Bun-only `craft` CLI** -- the published binary now requires Bun >= 1.1.0.
- **Bun monorepo** -- installs, scripts, and lockfile migrate from pnpm to Bun.
- **`create-routecraft` refactor** -- scaffolder extracted into a library with expanded test coverage.
- **`bun:test` everywhere** -- the internal suite migrates off vitest, retained only for the cross-runtime tests.

### Docs

- **Migration guide** -- new [0.4.x to 0.5.0 migration guide](/docs/migrating/0.4-to-0.5).
- **Canary docs at `/next/`** -- canary builds deploy alongside the stable build at the root.
- **Operator reference** -- `log` and `debug` documented; `map` and `schema` clarified.
- **Claude Code skills** -- Agent Skills for authoring adapters and capabilities bundled at the repo root.

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