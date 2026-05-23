# API Stability

How Routecraft marks the stability of its public API while it is pre-1.0.

## Policy at 0.x

Routecraft is v0. The **entire public API is unstable**: anything can change or be removed in any release. Because that applies to everything, we do **not** tag individual symbols with per-symbol stability tiers while in 0.x. There is nothing to distinguish, so tagging every export `@experimental` (or `@beta`) would be noise.

What we use instead:

- **`@internal`** -- marks a symbol that is not part of the public API. Use it for implementation details, even when the symbol is `export`ed so a sibling package can reach it. An `@internal` symbol carries no compatibility expectation and should not appear in user-facing docs. Ideally it is also not reachable from a package `index.ts`; where it currently is, `@internal` records the intent until the export is removed.
- **`@deprecated`** -- scheduled for removal. Name the replacement in the same note.

No symbol is tagged `@experimental`, `@beta`, or `@stable` in 0.x.

## When we reach v1

At 1.0 we will introduce per-symbol release tags to communicate stability:

- `@experimental` -- may change or be removed in any release.
- `@beta` -- shape settled, not yet committed; breaking changes only in a minor, with a changelog entry and migration note.
- `@stable` -- covered by semver; breaking changes only in a major.

Until then, treat the whole surface as `@experimental` by default and rely on the changelog and migration guides for what changed.

## Applying `@internal`

- Put it on the original declaration (the `export function` / `const` / `class` / `interface` / `type`), never on a re-export line in `index.ts`.
- Place it as a standalone line in the symbol's JSDoc block, after the description and any `@param` / `@example` lines.

## Related

- [Type Safety and Schemas](./type-safety-and-schemas.md) -- factory option types and type-flow policy
- [CI/CD](./ci-cd.md) -- PR gates and release flow
