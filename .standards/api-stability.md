# API Stability

How Routecraft marks the stability of its public API and what each tier promises. This tells contributors how to tag exported symbols; the user-facing meaning is rendered from these tags in the docs.

## Tiers

Routecraft uses TSDoc release tags on every publicly exported declaration:

- `@experimental` -- may change or be removed in any release. Use for new, volatile, or runtime-coupled surfaces.
- `@beta` -- the shape is settled and unlikely to change, but not yet committed. Breaking changes only in a minor release, with a changelog entry and a migration note.
- `@stable` -- covered by semver; breaking changes only in a major release. **Reserved for 1.0; nothing is `@stable` while Routecraft is 0.x.**
- `@deprecated` -- scheduled for removal; name the replacement in the same note.
- `@internal` -- not part of the public API. Must NOT be reachable from a package `index.ts`.

## Policy at 0.5.x

Routecraft is pre-1.0 and explicitly not stable. The 0.5.0 release changed core fundamentals (the move to Bun, the immutable Exchange, the dual-mode `.error()` wrapper, the stdout logger). Users must be able to see this from the API itself, not only the changelog.

Therefore, at 0.x:

1. **No symbol is `@stable`.**
2. **Every publicly exported symbol carries exactly one of `@experimental` or `@beta`.** Untagged is not allowed: an untagged export reads as stable, which is wrong for a 0.x package.
3. **`@beta`** is for the deliberately-settled surface: the route DSL / builder core, the error system, the mature source/destination adapters (`simple`, `timer`, `log`, `noop`, `http`, `file`, `csv`, `json`, `jsonl`, `html`, `group`, `cosine`, `event`), the `llm` / `embedding` / `mcp` basics and their provider-config types, and the test utilities.
4. **`@experimental`** is for everything new in 0.5 or coupled to volatile internals: the telemetry SQLite sink, the `mail` adapter, `direct`'s typed endpoints, the immutable `Exchange` itself, the agent / tools / skills runtime, the MCP server and OAuth surface, and all of auth.
5. An exported option / result / store-key type inherits the tier of the factory or class it belongs to. The two must not disagree.

## Applying the tag

- Put the tag on the original declaration (the `export function` / `const` / `class` / `interface` / `type`), never on a re-export line in `index.ts`.
- Place it as a standalone line in the symbol's JSDoc block, after the description, `@param`, and `@example` lines.
- When promoting a symbol (for example `@experimental` to `@beta`), update the tag and add a changelog entry.

## Enforcement

Today the tags are enforced by review against this policy. A future ESLint rule in `@routecraft/eslint-plugin-routecraft` should require every export reachable from a package `index.ts` to carry exactly one stability tag, and flag any `@internal` symbol that escapes through `index.ts`.

## Related

- [Type Safety and Schemas](./type-safety-and-schemas.md) -- factory option types and type-flow policy
- [CI/CD](./ci-cd.md) -- PR gates and release flow
