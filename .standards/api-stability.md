# API Stability

How Routecraft marks the stability of its public API while it is pre-1.0.

## Policy at 0.x

Routecraft is v0. The **entire public API is unstable**: anything can change or be removed in any release. Because that applies to everything, we do **not** tag individual symbols with per-symbol stability tiers while in 0.x. There is nothing to distinguish, so tagging every export `@experimental` (or `@beta`) would be noise.

What we use instead:

- **`@internal`** -- marks a symbol that is not part of the public API. Use it for implementation details, even when the symbol is `export`ed so a sibling package can reach it. An `@internal` symbol carries no compatibility expectation and should not appear in user-facing docs. Ideally it is also not reachable from a package `index.ts`; where it currently is, `@internal` records the intent until the export is removed.
- **`@deprecated`** -- scheduled for removal. Name the replacement in the same note.

No symbol is tagged `@experimental`, `@beta`, or `@stable` in 0.x.

## Versioning at 0.x

The same v0 posture governs changeset bump levels: **only `minor` and `patch` are used while in 0.x**. Breaking changes ship as `minor` (the whole 0.x line is the breaking window), and a conventional-commit `!` does not translate to a `major` changeset. `major` is reserved for the deliberate 1.0.0 release and requires an explicit maintainer decision recorded in the PR; a stray `major` recomputes the next version as 1.0.0 and stamps every canary `1.0.0-canary-*` (this has happened and the releases had to be deprecated). See [CI/CD](./ci-cd.md) section 9 for the release mechanics.

One mechanism looks like an exception but is not: changesets auto-major-bumps peer dependents when a core bump leaves their declared peer range (`onlyUpdatePeerDependentsWhenOutOfRange`). That cascade never fires pre-1.0 because the mandated peer-range form (CI/CD section 5, which is where the exact form lives) keeps every 0.x core minor inside the declared range. The only way to a 1.0.0 computation therefore remains a human-authored `major` changeset, which this policy forbids until the deliberate 1.0.0 release.

## When we reach v1

At 1.0 we will introduce per-symbol release tags to communicate stability:

- `@experimental` -- may change or be removed in any release.
- `@beta` -- shape settled, not yet committed; breaking changes only in a minor, with a changelog entry and migration note.
- `@stable` -- covered by semver; breaking changes only in a major.

Until then, treat the whole surface as `@experimental` by default and rely on the changelog and migration guides for what changed.

## Port versions

Ports are the one place 0.x makes a compatibility promise, because a port is
the seam two independently released plugins meet at. From 0.8.0 the version
in a port's name is its contract: the value read under `name@N` keeps its
shape while that name exists, and a change of shape ships under `name@N+1`
(the bump rule and the snapshot test that holds it are in
[Plugin Architecture](./plugin-architecture.md#ports)). The promise is that
one name never means two shapes, so a plugin built against a port either
finds that contract or fails at install. It is not a promise that a port
stays: a port may still be retired or re-versioned in any 0.x release, with a
migration note.

Two ports are excluded by name. `RESILIENCE` (`routecraft.resilience@1`) and
`ENFORCEMENT` (`routecraft.enforcement@1`) are **provisional**: the first is
due to split into one port per position and the second to take a reshaped run
context with a required `admits`, and both changes land together so a
provider author takes one break. Until then either may change shape in a
minor release without becoming `@2`. They are marked `@remarks Provisional`
on the token and `provisional` in the snapshot, the test refuses a third
exception, and a plugin that replaces either pins the Routecraft minor it was
written against.

## Types a declaration names are public

A type that appears in an emitted declaration (a route's `.d.ts` names the
builder's derived method types) or that a package augments through
`declare module "@routecraft/routecraft"` has to be exported from the entry
point, and an `@internal` tag on it would be false. Such types are public and
carry no tag: `DerivedStepMethods`, `PluginMethods`, `FacetsOf`,
`ShippedPluginTypes`, `DefaultPluginTypes`. Where only first-party code may
merge into one, its JSDoc says so.

## Applying `@internal`

- Put it on the original declaration (the `export function` / `const` / `class` / `interface` / `type`), never on a re-export line in `index.ts`.
- Place it as a standalone line in the symbol's JSDoc block, after the description and any `@param` / `@example` lines.

## The `/internal` subpath

`@routecraft/routecraft/internal` is where a name lives when a sibling `@routecraft/*` package needs it and a third party must not build on it. It holds three kinds of thing: the hooks `@routecraft/testing` uses to override an adapter, build helpers the first-party packages share so they apply one rule rather than a copy of it, and the two exchange accessors (`getExchangeContext`, `getExchangeRoute`) the agent tier still reads the application through. The accessors are a debt: `kernel-boundary.bun.test.ts` lists the files allowed to import them, and the list only shrinks. The list is `packages/routecraft/src/internal.ts`, and a test holds it.

- It carries no compatibility promise. A name there may change or go in any release, and an import from outside the `@routecraft` scope is unsupported.
- It is not a way around the main entry. A capability an outsider needs (reaching a plugin's state from an adapter, deferring, resuming) gets a public export; it never arrives through the subpath. The outsider suites cannot import it.
- It is bundled apart from the main entry, so everything it reaches exists twice at runtime. A module it re-exports holds no state (a registry or a cache reached through it would be a second copy), and identity crosses the two bundles through `Symbol.for` and brands, never `instanceof`. The build holds the second half: `verify-dist.mjs internal` raises an error through the subpath and has the main entry recognise it.
- A sibling imports it from its `src/` or `test/` only. Examples, templates, skills and the docs never import it; a resolver map that points the name at source for a test run is not an import.

## Related

- [Type Safety and Schemas](./type-safety-and-schemas.md) -- factory option types and type-flow policy
- [CI/CD](./ci-cd.md) -- PR gates and release flow
