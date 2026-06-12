# Package Boundaries

Where code lives across the `@routecraft/*` packages and what dependencies each kind of package may carry. Decided 2026-06-12; refined the same day after a roadmap review of every planned adapter and a survey of how comparable tools (Apache Camel, n8n, Make/Zapier, Terraform, Airbyte, Spring Integration) package connectors.

The goal is a bounded package count: roughly 8 to 12 runtime integration packages long term, regardless of how many integrations exist. Tooling and dev-plugin packages are separate and do not grow with integrations (see section 8).

---

## 1. The placement test: standard, system-native, or vendor?

Every adapter is exactly one of three kinds, and the kind decides the package.

1. **Open standard** (a format, a protocol, or a data store with more than one independent implementation) goes in **core** (`@routecraft/routecraft`).
2. **System-native capability** (touches the host machine, carries heavy or native peers, has a security surface) goes in **`@routecraft/os`**.
3. **Proprietary single-vendor product** goes in a **grouped vendor package**, never its own package per integration.

Note what the test is NOT. It is not "touches the OS" (`file` touches the OS and is a core standard). It is not "has a Bun-native client" (that is evidence of ubiquity, not a placement reason). The axis is what the thing fundamentally is.

## 2. Standards live in core

Core holds the framework plus open standards. Three sub-kinds:

- **Formats (codecs):** csv, json, jsonl, html, yaml. These are transport-agnostic transformers, not local-file loaders. A file-read convenience mode on some of them is incidental; the codec itself works against any transport (an HTTP body, an S3 object, a Kafka message).
- **Protocols / transports:** http (in/out, SSE, OAuth server, OpenAPI), websocket, graphql, file (local fs), mail (SMTP/IMAP), carddav, cron, timer, ftp/sftp, and the messaging protocols kafka, rabbitmq/amqp, mqtt, nats, plus grpc.
- **De-facto-standard data stores:** see section 2.1.

### 2.1 The de-facto-standard rule

A vendor-named API counts as a standard, and therefore lives in core, when it has multiple independent implementations of the same wire or API:

- **S3 API** (MinIO, Cloudflare R2, Backblaze B2) -> core. AWS's *proprietary* services (SQS, SNS, Lambda) are not standards and go to `@routecraft/aws`.
- **PostgreSQL wire**, **MySQL/MariaDB wire** -> core.
- **RESP / Redis** (Valkey, KeyDB) -> core, as the cache provider.
- **MongoDB** (FerretDB, DocumentDB), **Cassandra CQL** (ScyllaDB), **Elasticsearch / OpenSearch** -> core.
- **Kafka** (Redpanda) -> core.

A Bun-native client (`Bun.s3`, `Bun.redis`, `bun:sqlite`) is downstream evidence that the API is ubiquitous, not the reason it is in core. The reason is multiple independent implementations. The heavy client for each is an optional peer (section 7), so core stays installable without any of them.

### 2.2 The core adapter plan (the data plane)

This is the Camel-territory layer Routecraft owns natively. Existing adapters are unmarked; planned ones cite their issue.

| Group | Adapters |
|---|---|
| Formats | csv, json, jsonl, html, yaml |
| HTTP family | http, SSE (#388), websocket (#389), graphql, oauth server (#390), OpenAPI converters (#392) |
| Files / transfer | file, ftp/sftp |
| Mail / scheduling | mail, cron, timer |
| Relational | postgres (#294), mysql/mariadb, sqlite |
| NoSQL / search | mongodb, cassandra, elasticsearch/opensearch |
| Cache | redis (#366) |
| Object store | s3 (#295) |
| Messaging | kafka, rabbitmq/amqp, mqtt, nats |
| RPC | grpc |
| Plumbing | direct, simple, log, noop, group, cosine |

Native adapters beat MCP here: throughput, streaming, backpressure, exactly-once, and no LLM in the loop.

## 3. System-native capabilities: `@routecraft/os`

`@routecraft/os` is the home for capabilities that are neither standards nor vendor products: they drive the host machine, carry heavy or native peers, and have a security surface. They do not belong in core (they would break core's zero-hard-dependency ambition and drag a security model into the framework), and they are not AI-specific (an agent reaches them through a tool, but the capability is host control).

Members, current and likely:

- `shell()` - subprocess execution (#181)
- `sandbox()` - sandboxed execution as a first-class concept (section 3.1)
- `agentBrowser()` - browser automation, merged from `@routecraft/browser` (section 3.2)
- `clipboard()`, `notify()`, `watch()`, `screen()`, `process()` - future host capabilities

We keep the name `@routecraft/os` rather than "computer-use": `os` is broader and covers non-agent host capabilities (clipboard, notifications) that the AI-framed "computer use" label would not.

### 3.1 Secure by default

Routecraft's mission is secure-by-default integration, and the os package is where that is most load-bearing.

- `shell()` runs inside a **sandbox tier by default**, not raw on the host. Raw host access is possible but always explicit, never the default.
- The sandbox shares **only the environment variables the route node declares it needs**. A tool can do only what the route granted it.
- Argument sanitisation (`shescape`) is always on, on every tier.

`shell()` versus a separate `sandbox()` adapter, and the exact tier defaults, are a #181 design detail. The principle (sandbox-by-default, env-scoped) is fixed here. See also [`security.md`](./security.md).

### 3.2 `@routecraft/browser` merges into `@routecraft/os`

Browser automation was split into `@routecraft/browser` in #168, but it is a system-native capability and belongs with `shell`. The os package's own description already claimed "shell execution and browser automation," so this aligns the package with its stated intent.

At the time of the merge `@routecraft/os` was an unpublished placeholder (private, reserved for shell, #181) and `@routecraft/browser` was published at `0.5.0`, so there was no name collision. `@routecraft/os` is now public and carries the browser adapter; `@routecraft/browser` is deprecated on npm pointing at it.

Migration:

1. Move the adapter source into `packages/os`; export `agentBrowser()` from `@routecraft/os`; add `agent-browser` as an optional peer there.
2. Remove `private: true` from `packages/os/package.json` and publish `@routecraft/os` (carrying shell and the browser adapter).
3. `npm deprecate "@routecraft/browser@*" "Moved to @routecraft/os"`.
4. We are v0 with an explicitly unstable public API (`api-stability.md`), so take the clean break: no long-lived re-export shim.

Accepted trade-off: a browser-driver change now bumps the whole `@routecraft/os` version, the same blast-radius trade-off accepted for vendor packages (section 4). The factory keeps the name `agentBrowser()`, which ties it to the library it wraps and leaves room for sibling browser drivers.

## 4. Vendors group by ecosystem or shared-interface domain

Proprietary single-vendor products never get a package per integration. They group, one package per logical domain.

| Package | Contents | Status |
|---|---|---|
| `@routecraft/google` | Google ecosystem: googlechat (#370), then gmail, Sheets, Docs, Drive, Calendar, PubSub, BigQuery | created on first adapter |
| `@routecraft/aws` | Proprietary AWS services: SQS, SNS, DynamoDB, Kinesis, Lambda, SES, EventBridge. **S3 stays in core** (section 2.1) | deferred until first such adapter |
| `@routecraft/azure` | Azure / Microsoft 365: Service Bus, Event Hubs, Blob, Cosmos, Teams, Outlook, Excel, Graph | future |
| `@routecraft/auth` | Vendor auth providers: clerk, workos. Must be transport-agnostic (consumed by both MCP and HTTP transports) | named, not built |
| `@routecraft/messaging` | Chat/comms SaaS with an inbound event source: slack, telegram, discord, twilio | telegram births it (section 4.1) |
| `@routecraft/integrations` | Optional single catch-all for genuine one-off SaaS with no shared interface, only if we ever build one instead of recommending MCP | created only if needed |

Rules:

- A new integration **within** an existing domain goes into that domain's package; it never creates a new package.
- A new **logical domain** creates exactly one package, on first adapter, following [`ci-cd.md` section 4](./ci-cd.md#4-adding-a-new-package-the-checklist). Never speculatively.
- Group by a **real shared interface** (auth shares the `Principal` object; messaging shares send/receive plus an event source). If two providers do not share an interface, they go in the single honest `@routecraft/integrations` catch-all, not a fake domain like "productivity SaaS." Split a real domain out of the catch-all only when a second provider with a shared interface appears.
- Accepted trade-off, stated explicitly: grouping means a change to one provider ships a version bump for its package-mates (a WorkOS change ships a Clerk update; a Sheets change bumps all of `@routecraft/google`).

### 4.1 Telegram births `@routecraft/messaging`; there is no `@routecraft/telegram`

Telegram is a one-off messaging SaaS. It should be the adapter that creates `@routecraft/messaging`, not its own single-vendor package. This is the same rule that made #370 name its package `@routecraft/google` rather than `@routecraft/googlechat`. Issues #367 and #368 are stale on the package name. Telegram and Discord earn native adapters (not MCP) because they are inbound event sources and because neither vendor ships an official MCP server (section 5).

## 5. SaaS long tail: prefer the vendor's MCP server

Routecraft owns the data plane natively and rents the action-plane long tail through MCP. This is what keeps the package count bounded while the integration universe grows into the hundreds. As of mid-2026, 23 of 26 surveyed major SaaS ship an official, vendor-maintained MCP server (GitHub, Slack, Notion, Linear, Monday, Airtable, Stripe, Atlassian, HubSpot, Salesforce, Asana, Shopify, PayPal, Square, Sentry, Vercel, Cloudflare, Intercom, and more).

The rule for whether to build a native adapter or recommend the vendor's MCP:

> **Build native** when the integration is data-plane (throughput, streaming, deterministic), **or** an inbound event source, **or** the vendor has no mature official MCP server.
> **Recommend MCP** (wired through the MCP client, see section 6) when a mature official server exists and the use is agent-driven actions. Ship no adapter; people can still write their own.

Worked examples:

- **No / immature official MCP -> native:** Telegram and Discord (community-only MCP), Google Sheets (Google's Workspace MCP is Developer Preview and does not cover Sheets), Twilio (official MCP is alpha).
- **Mature official MCP + action-plane -> recommend MCP, zero adapters:** Notion, Linear, Monday, Airtable, Stripe, Jira/Confluence, HubSpot, Salesforce, Asana, Shopify, PayPal, Sentry, Vercel, Intercom.
- **Both:** Slack and GitHub get a native event source (data plane) and we point at their official MCP for agent actions.

Note on determinism: MCP is a thin protocol over HTTP and is usable from any route, AI or not. We do not claim MCP is "wrong" for non-agent routes. The only open question is where the client lives (section 6).

## 6. AI and the MCP client: `@routecraft/ai`

`@routecraft/ai` holds the genuinely AI parts: `llm()`, `agent()`, embeddings, the provider seam (OpenAI, Anthropic, Gemini, OpenRouter, Ollama, custom, plus future Mistral/Cohere/DeepSeek/Bedrock/Vertex via the Vercel AI SDK), and the agent tools (`WebFetch`, `WebSearch`, `Bash`). It is an ecosystem package, not core, and depends on the Vercel AI SDK; docs must not present it as core.

**Open decision:** the `mcp()` client is a transport over a protocol, not an AI feature. By the section 2 rule (standards live in core), the MCP client transport arguably belongs in **core**, so a plain non-AI route can use `mcp()` without importing the AI module, leaving only the AI-specific pieces in `@routecraft/ai`. Recorded here as undecided; resolve before v1.

## 7. Dependency policy for core

Zero third-party runtime dependencies in core is the **ambition, not a hard rule**. Exceptions are allowed when the library is popular, well maintained, and makes the effort significantly easier than inlining. Adding a hard dependency to core is a reviewed decision.

- **Accepted core dependencies:** `pino`, `lru-cache`, `@opentelemetry/api`, `@standard-schema/spec`. The latter two are interface standards with no meaningful runtime.
- **Bun-native APIs** (`Bun.redis`, `Bun.s3`, `bun:sqlite`) do not count against the budget, but core targets Node 22+ as well as Bun, so any Bun-native usage needs a Node-equivalent path (a `node:` builtin or an optional peer such as `@aws-sdk/client-s3`), proven by cross-runtime tests per [`ci-cd.md` section 2](./ci-cd.md#2-the-pr-gates).
- **Vendor and protocol SDKs for adapters are never hard dependencies.** They are optional peers loaded through `loadOptionalPeer` with an `RC5017` install hint, per [`ci-cd.md` section 6](./ci-cd.md#6-optional-peer-dependencies-provider-sdks). Installing core must never pull a vendor SDK transitively.

Ecosystem and system-native packages are not bound by the core ambition. `@routecraft/ai` depends on the Vercel AI SDK, and `@routecraft/os` depends optionally on `agent-browser` today (adding `execa`/`shescape`/`dockerode` when `shell` lands). They still follow the `@routecraft/*` peer-dependency shape in [`ci-cd.md` section 5](./ci-cd.md#5-dependency-policy-on-routecraft).

## 8. The complete module map

Three kinds of module. The 8-to-12 bound governs only the first group.

### A. Runtime libraries (installed for routes)

| Package | Today / planned | Disposition |
|---|---|---|
| `@routecraft/routecraft` | core: framework + standards | keep; add graphql; consider absorbing the MCP client (section 6) |
| `@routecraft/ai` | llm, agent, mcp, embeddings, providers, agent tools | keep |
| `@routecraft/os` | system-native: shell, sandbox, browser, ... | keep; absorbs `@routecraft/browser` |
| `@routecraft/browser` | browser automation | merge into `@routecraft/os`, deprecate the name |
| `@routecraft/google` | Google ecosystem | on first adapter (#370) |
| `@routecraft/aws` | proprietary AWS services | deferred (S3 stays core) |
| `@routecraft/azure` | Azure / Microsoft 365 | future |
| `@routecraft/auth` | clerk, workos | named, not built |
| `@routecraft/messaging` | slack, telegram, discord, twilio | telegram births it |
| `@routecraft/integrations` | one-off SaaS catch-all | only if ever needed |

### B. Tooling and runtime CLI

| Package | Role |
|---|---|
| `@routecraft/cli` | the `craft` binary (run routes/contexts) |
| `create-routecraft` | project scaffolder |

### C. Dev and authoring plugins (not installed at runtime)

| Package | Role |
|---|---|
| `@routecraft/testing` | spy logger, testContext, pseudo, fixtures |
| `@routecraft/eslint-plugin-routecraft` | lint rules |
| `@routecraft/prettier-plugin-routecraft` | compact DSL formatting |

## 9. What this supersedes

- An earlier note (March 2026) to move `mail()` into `@routecraft/email` is dead. Mail is a protocol standard and stays in core. Vendor mail products (Gmail-specific APIs) go to `@routecraft/google`.
- `s3`, `postgres`, and `redis` in core are justified as **de-facto standards** (multiple independent implementations), not as "Bun-native is free." This draws the AWS line: the S3 API is core, proprietary AWS services are `@routecraft/aws`.
- `telegram` lands in `@routecraft/messaging`, not a `@routecraft/telegram` package (#367/#368 stale on the name).
- `@routecraft/redis` as a standalone package name (#366) is stale; redis is a core cache provider.
- `@routecraft/browser` folds into `@routecraft/os` (#168 reversed on packaging, capability retained).

## 10. The resulting structure: packages and their adapters

Applying the rules above produces the package structure below. Use it to place any new adapter, and when a new package or grouping is created, record it here so this guide stays the source of truth.

**Build legend:** `Native-core` = adapter in `@routecraft/routecraft`. `Native-pkg` = adapter in a vendor or domain package. `MCP` = no adapter; recommend the vendor's official MCP server via `mcp()`. `Both` = native for the data/event plane, MCP for agent actions.

### Layer 1 - data plane (Native-core)

The full core adapter plan is in section 2.2. In short: formats (csv, json, jsonl, html, yaml); HTTP family (http, SSE, websocket, graphql, oauth server, OpenAPI); files (file, ftp/sftp); mail; cron/timer; relational (postgres, mysql/mariadb, sqlite); NoSQL/search (mongodb, cassandra, elasticsearch/opensearch); cache (redis); object store (s3); messaging (kafka, rabbitmq/amqp, mqtt, nats); RPC (grpc).

### Layer 2 - cloud ecosystems (Native-pkg, one package per vendor)

| Ecosystem | Package | Adapters |
|---|---|---|
| AWS | `@routecraft/aws` | sqs, sns, dynamodb, kinesis, lambda, ses, eventbridge (s3 stays core) |
| Google | `@routecraft/google` | googlechat (#370), gmail, sheets, docs, drive, calendar, pubsub, bigquery |
| Azure / Microsoft | `@routecraft/azure` | service bus, event hubs, blob, cosmos, teams, outlook, excel, graph |

### Layer 3 - messaging / comms (`@routecraft/messaging`)

| Tool | Build | Note |
|---|---|---|
| slack | Both | native event source + official MCP for actions |
| telegram (#367/#368) | Native-pkg | births the package; no official MCP (community only) |
| discord | Native-pkg | no official MCP (community only) |
| twilio | Native-pkg | official MCP is alpha; native for SMS/voice/webhooks |

### Layer 4 - action-plane SaaS (MCP, no adapter)

Recommend the vendor's official MCP server through `mcp()`; ship no adapter. People can still write their own. Official MCP servers confirmed mid-2026 unless noted.

| Tool | Category | Build |
|---|---|---|
| github | dev | Both (optional native webhook source; MCP for actions) |
| gitlab, sentry, vercel, cloudflare | dev / infra | MCP |
| jira / confluence (atlassian), linear, asana, monday | project mgmt | MCP |
| trello, clickup | project mgmt | MCP (partner/community) |
| notion | docs | MCP |
| salesforce, hubspot, pipedrive | CRM | MCP |
| stripe, paypal, square | payments | MCP |
| shopify, woocommerce | e-commerce | MCP |
| airtable | structured data | MCP |
| intercom, plaid | support / fintech | MCP |
| typeform, google forms, calendly | forms / scheduling | Native-trivial (`http()` webhook) or MCP |
| mailchimp, brevo, sendgrid | email marketing | Native-light (core `mail`/`http`) or MCP |

### Layer 5 - AI providers (`@routecraft/ai`)

Provider entries via the Vercel AI SDK seam (#385), not packages. Have: openai, anthropic, gemini, openrouter, ollama, custom. Planned: mistral, cohere, deepseek, perplexity, bedrock, vertex, azure openai.

## Related

- [CI/CD](./ci-cd.md) -- adding a package, dependency shapes, optional peers
- [Adapter Architecture](./adapter-architecture.md) -- how to build the adapter once its home is decided
- [Naming Policy](./naming-policy.md) -- what to call it
- [Security](./security.md) -- protocol-level auth in core, and the sandbox-by-default contract for `@routecraft/os`
