# Content and Docs

How to decide where a piece of content belongs across the docs site and the blog. This exists
because the same topic (MCP, auth) kept appearing in multiple places with no clear owner, and
the navigation drifted out of sync with the folder structure.

**Boundary:** this standard governs how we organise content. What the content teaches still
follows the per-area docs and the user-facing site.

## The five surfaces

The split between `introduction/` and `advanced/` is a **depth axis**, not a concept-vs-guide
split. Both are concept-led; advanced just goes deeper and may also carry guides.

| Surface | Home | Job | Maintained | Vendor-specific |
|---|---|---|---|---|
| Foundational concept | `docs/introduction/` | the basics: what it is, how the core works | yes | no |
| Advanced concept (+ guides) | `docs/advanced/` | deeper concepts and how to apply them; guides welcome | yes | no |
| Reference | `docs/reference/` | every option, lookup | yes | no |
| Example | `docs/examples/` | runnable real-world use case; the single source of code | yes | minimal |
| Blog | `blog/` | story, named vendor, or comparison; version-pinned | no | yes |

## Decision tests

1. **Basics or depth?** Foundational goes in `introduction/`, deeper goes in `advanced/`.
   Same author voice, different level.
2. **Maintained-forever and generic?** It is docs. **Dated or vendor-named?** It is a blog
   post. A vendor walkthrough (Clerk, Stripe, WorkOS) is always a blog post, never an
   `advanced/` page; the `advanced/` page is the vendor-neutral version the blog links back to.
3. **Is it a framework noun or a company?** Framework noun (auth, MCP, retries) gets a neutral
   `advanced/` page. Company gets a blog post.

## Rules

- **Code lives once.** Runnable code lives in `examples/` (the repo's `examples/src` and the
  matching `docs/examples/*` pages). Guides and blog posts excerpt it; they do not re-author
  it. A topic may legitimately appear as reference + guide + example + blog at once, as long
  as each plays only its own role and links to the others.
- **Navigation matches folders.** A page's nav group and its URL folder must name the same
  surface. `apps/routecraft.dev/src/lib/navigation.ts` is the source of truth for grouping; keep it aligned with
  the `docs/<surface>/` folder each page lives in.
- **No silent duplication.** When two pages cover one topic (for example a how-to and a
  catalog), each owns its half. Do not copy a table into both; link to the one that owns it.
- **Examples are real-world use cases.** A `docs/examples/*` page solves a problem a real user
  has (reconcile payments, chase overdue invoices, sync a CSV). Scratch capabilities, feature
  demos, and the throwaway capabilities under the repo's `examples/src` are not showcase
  examples and do not get an examples page just because they exist.

## Capability project structure (public-surface file)

Recommended project layout is one folder per capability under `capabilities/<domain>/<id>/`,
with **`route.ts`** as the public surface (default export plus its input/output types). Only
`route.ts` is importable from outside the folder; cross-capability reuse goes through
`direct('<id>')` plus the types re-exported from the callee's `route.ts`.

Decision record: the file is named `route.ts`, matching what `craft()` returns internally,
even though `route` is otherwise an internal term kept out of user-facing copy (see
[Naming Policy](./naming-policy.md)). This is a deliberate, scoped exception chosen for
symmetry with the builder; `capability.ts` was the consistency-preferring alternative and was
not taken. The user-facing noun for the unit of work remains "capability".

A single-file capability (`capabilities/<id>.ts`) is acceptable shorthand for a trivial,
internal-free capability (the repo's own `examples/src` deliberately uses the flat form).

## Changelog entries

The changelog (`apps/routecraft.dev/src/app/changelog/page.md`) is for a user scanning to decide
**whether and how to upgrade**. It is not a design doc, a reference, or a migration guide. It names
what changed and points to the surface that owns the detail. This follows the
[Keep a Changelog](https://keepachangelog.com) convention: entries are written for humans, kept
short, and link out for depth. The v0.1-v0.4 entries are the house style; v0.5/v0.6 drifted and
were trimmed back to it.

**Shape of an entry.** One bullet per user-visible change, grouped by area (Core, AI & MCP, Mail,
Adapters, Telemetry, Docs, etc.). Each bullet is a **bold lead phrase** in user terms, then ` -- `
and one sentence of impact. A second sentence is allowed only when a behaviour change has a precise
condition a user needs to recognise (for example which messages a trust-classification fix now
treats differently). Lead a breaking bullet with the removed or renamed symbol so a reader grepping
their code finds it. Rely on the group-level `{% badge color="red" %}Breaking{% /badge %}` rather
than repeating "breaking" per bullet.

**What does not go in the changelog** (it lives elsewhere, and the entry links to it):

- Design rationale and the "why" behind a decision -- the migration guide narrative or the PR.
- Parameter signatures, field lists, option shapes, type definitions -- the reference page.
- Step-by-step field migrations and before/after tables -- the migration guide.
- Internal-only changes with no user-visible effect -- omit entirely.

**Length test.** If a bullet runs past two lines, or names more than one parameter or field, it is
carrying detail that belongs in the migration guide or reference. Cut it to the headline and link
out. This is the same "no silent duplication" and "code lives once" discipline applied to release
notes: the changelog owns the one-line announcement, not the explanation.

## Operational constraint: redirects

The docs site builds with Next.js `output: 'export'` (see `apps/routecraft.dev/next.config.mjs`),
so `async redirects()` does **not** run: there is no server to honour it. Prefer repurposing a
page in place over moving or deleting its URL. If a URL must change, the redirect has to be
handled at the host (Cloudflare), which is outside this repo, so coordinate it explicitly.
