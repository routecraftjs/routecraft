---
title: Changelog
---

All notable changes to RouteCraft. {% .lead %}

RouteCraft is in active development -- APIs may change between minor versions.

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