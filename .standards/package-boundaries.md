# Package Boundaries

Where code lives across the `@routecraft/*` packages and what dependencies each kind of package may carry. Decided 2026-06-12; this codifies the package-boundary decision so contributors and review bots can check changes against it.

The goal is a bounded package count: roughly 8 to 12 packages long term, regardless of how many integrations exist.

---

## 1. Standards live in core; vendors group by ecosystem

The boundary question for any new adapter is: **is this a protocol standard or a vendor product?**

- **Protocol standards stay in core** (`@routecraft/routecraft`): HTTP, mail (SMTP/IMAP), CardDAV, cron, files, CSV, JSONL. A standard outlives any vendor, and its SDK cost is contained by the optional-peer mechanism (section 3).
- **Vendor products group into one package per logical domain**, never one package per integration:

| Package | Contents |
|---------|----------|
| `@routecraft/auth` | Vendor auth providers that do not justify their own package: `clerk()`, `workos()`, and peers. Accepted trade-off: a WorkOS change ships a Clerk update too; it is one package. |
| `@routecraft/google` | Google ecosystem: a `gmail` adapter (mail-the-protocol stays in core), Sheets, Docs, PubSub. |
| `@routecraft/messaging` (future) | Slack, Teams, and similar, when needed. |

Rules that follow:

- A new integration **within** an existing domain goes into that domain's package. It never creates a new package.
- A new **logical domain** creates exactly one new package, following the checklist in [`ci-cd.md` section 4](./ci-cd.md#4-adding-a-new-package-the-checklist).
- Packages are created **when their first adapter lands**, not speculatively. An empty package is release-train weight with no user.

## 2. Auth: protocol in core, vendors in `@routecraft/auth`

JWT, JWKS, API keys, OAuth flows, and the principal object are protocol-level standards and stay in core (see [`security.md`](./security.md)). Vendor products on top of them (Clerk, WorkOS) belong in `@routecraft/auth`.

`@routecraft/auth` factories must be **transport-agnostic**: they return the common auth interface consumed by both the MCP transport and the HTTP transport. The same `workos()` call works on either; the transport does not care how auth works internally.

## 3. Dependency policy for core

Zero third-party runtime dependencies in core is the **ambition, not a hard rule**. Exceptions are allowed when the library is popular, well maintained, and makes the effort significantly easier than inlining or reimplementing. Adding a hard dependency to core is a reviewed decision, not a default.

- **Accepted core dependencies** (the current exception list): `pino`, `lru-cache`, `@opentelemetry/api`, `@standard-schema/spec`. The latter two are interface standards with no meaningful runtime of their own.
- **Bun-native APIs** (Redis, S3) are always fine: no external SDK is introduced.
- **Vendor and protocol SDKs for adapters are never hard dependencies.** They are optional peers loaded through `loadOptionalPeer` with an `RC5017` install hint, per [`ci-cd.md` section 6](./ci-cd.md#6-optional-peer-dependencies-provider-sdks). Installing core must never pull a vendor SDK transitively.

Ecosystem packages are not bound by the core ambition. `@routecraft/ai` depends on the Vercel AI SDK and that is accepted: `@routecraft/ai` is **not core**, and docs must not present it as such. Ecosystem packages still follow the `@routecraft/*` peer-dependency shape in [`ci-cd.md` section 5](./ci-cd.md#5-dependency-policy-on-routecraft).

## 4. What this supersedes

An earlier note (March 2026) proposed moving `mail()` out of core into `@routecraft/email`. That is superseded: mail is a protocol standard and stays in core. Vendor mail products (Gmail-specific APIs) go to `@routecraft/google` when built.

## Related

- [CI/CD](./ci-cd.md) -- adding a package, dependency shapes, optional peers
- [Adapter Architecture](./adapter-architecture.md) -- how to build the adapter once its home is decided
- [Naming Policy](./naming-policy.md) -- what to call it
- [Security](./security.md) -- the protocol-level auth that stays in core
