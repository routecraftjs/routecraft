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

## Blog figures

Blog diagrams are React components, not images. Each one lives in
`apps/routecraft.dev/src/components/figures/` and is registered by id in that folder's
`index.ts`. A figure is drawn on a fixed canvas and scaled by `<ScaledFrame>`, so the
composition never reflows: the same drawing at every width, just smaller.

Every figure ships in two resolutions, because it renders on surfaces with very different
size budgets:

- **`Figure`** is the full drawing. It renders in the browser only, so it may use grid and
  `color-mix`. Type and colour come from the `primitives.tsx` vocabulary and the `palette`
  prop, not from Tailwind classes, so the drawing stays self-contained and a subtree of it
  can be lifted into a motif. Place it with `{% diagram id="..." /%}` at the point in the
  prose where the argument needs it.
- **`Motif`** is the same idea reduced to shapes that survive a 368px index card and a social
  preview. It replaces the cover glyph when a post sets `diagram: <id>` in frontmatter, which
  puts the same mark on the post hero, the index card, the home teaser, and the OG image.

Two constraints follow from that split:

- **Motifs render through Satori.** Inline styles only, flexbox only, no CSS variables, no
  pseudo-elements, no `color-mix`. A motif that uses an unsupported feature does not fail the
  build; it renders wrong in the social image, where nobody is looking. Keep text out of a
  motif entirely: if it needs words, it has not been reduced far enough.
- **Colours are always passed in, never read from CSS.** Motifs take a `CoverPalette`, so
  `COVER_PALETTE_LIGHT` in `BlogCover.tsx` is what Satori resolves and `COVER_PALETTE_THEMED`
  is what the browser follows. Figures take a `FigurePalette`, of which only
  `FIGURE_PALETTE_THEMED` exists, because a figure never renders through Satori. All three
  mirror the tokens in `tailwind.css`, so when the brand palette moves, all of them move.

Write a real `alt` on every figure: it is the accessible name, and a DOM drawing gives a
screen reader nothing on its own.

### Scaling: never through `<foreignObject>`

`<ScaledFrame>` measures its own width and applies a CSS `transform: scale()`. The obvious
alternative, wrapping the artwork in an SVG `viewBox` with a `<foreignObject>`, is prettier
(pure CSS, no measurement) and was how this worked until it turned out that **WebKit paints
foreignObject content at 1:1, ignoring the viewBox, as soon as anything in the subtree is
positioned**. Every one of these drawings positions something, so on Safari every cover and
figure showed the top-left corner of its canvas at full size, at every viewport width. Adding
`width`/`height` attributes, an `xmlns`, `overflow: hidden`, or a static wrapper does not
help; only dropping foreignObject does.

So: measure and transform. Check Safari, not just Chrome, on anything that scales fixed-canvas
artwork. Because the frame has to measure before it can scale, artwork stays hidden until the
first measurement and `tailwind.css` carries a `@media (scripting: none)` fallback.

### At phone width, a figure is a picture

A 1600x900 drawing scaled into a 358px column is complete but unreadable, so `{% diagram %}`
makes the figure a lightbox trigger: tapping opens the exported PNG full-screen, filling the
height and panning horizontally, with the dark file served in dark mode. **The exported PNGs
are therefore part of the site, not just syndication assets** -- a figure whose PNG is stale
or missing enlarges to the wrong thing or to nothing.

### Exporting a figure

A figure is HTML and CSS, so it draws in a browser and nowhere else: a standalone `.svg`
renders blank through an `<img>` tag, and Satori cannot lay one out either. Both the lightbox
and anywhere a post is republished (dev.to, a slide, a newsletter) need a raster.

Every figure therefore has its own page at `/figures/<id>/`, which shows the drawing at its
authored size next to the URLs and markdown snippet for its PNGs. `/figures/` is the gallery.
Both are `noindex`: they are utility surfaces, not arguments.

The PNGs are produced by `scripts/export-figures.ts`, which serves the built export, drives
Chromium over each figure page, and writes two files per figure at 2x:
`<id>.png` (light) and `<id>-dark.png`. Light is the unsuffixed default because it is the
safer choice on a surface whose background we do not control, and because one guessable URL
per figure is worth having. The theme comes from the emulated colour scheme, which is what
next-themes resolves against when no preference is stored:

```sh
bun run build && bun run figures:export      # all figures
bun run figures:export four-gates            # just one
bunx playwright install chromium             # once, before the first export
```

A figure id may not end in `-dark`; the export rejects it rather than let one figure's light
file overwrite another's dark one.

Run it whenever a figure changes, and commit the PNGs; the site itself serves them, so a
skipped export ships a post whose figure enlarges to the previous drawing. They are checked in
rather than built in CI so the Pages workflow never has to install a browser. The page and the script agree on
the output path and the screenshot marker through `src/lib/figure-image.ts`; keep new
surfaces reading from there rather than hardcoding `/images/figures/`.

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
