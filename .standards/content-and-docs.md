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
  surface. `apps/routecraft.dev/app/lib/navigation.ts` is the source of truth for grouping; keep it aligned with
  the `docs/<surface>/` folder each page lives in.
- **No silent duplication.** When two pages cover one topic (for example a how-to and a
  catalog), each owns its half. Do not copy a table into both; link to the one that owns it.
- **Examples are real-world use cases.** A `docs/examples/*` page solves a problem a real user
  has (reconcile payments, chase overdue invoices, sync a CSV). Scratch capabilities, feature
  demos, and the throwaway capabilities under the repo's `examples/src` are not showcase
  examples and do not get an examples page just because they exist.

## Cross-posted blog articles

Some blog posts run on both routecraft.dev and devoptix.nl as one article, and every such
pair has exactly one home, declared by which file carries `canonical:` in its frontmatter
(an absolute URL pointing at the original publication; the home post carries none):

- **Thought leadership belongs to devoptix.nl.** Posts whose argument stands without code
  (organisational patterns, maturity ladders, buying advice) are canonical on devoptix.nl;
  the routecraft.dev copy sets `canonical:` to the devoptix.nl URL.
- **Code-first posts belong to routecraft.dev.** Posts whose spine is Routecraft code or
  the framework itself are canonical here; the devoptix.nl copy points back.

Setting `canonical:` on a post drives the canonical link tag, `og:url`, and JSON-LD
`mainEntityOfPage`, removes the post from the sitemap (it stays in the RSS feed, which
serves this site's readers rather than crawlers), renders an "originally published at"
line on the page, and stamps the same attribution into the `/raw/blog/*.md` output.

The two copies are the same article, not two articles: identical spine, identical section
structure, at most a site-specific closing block (product close here, engagement close
there) and per-site link paths and figure syntax. When editing a cross-posted article,
apply the edit to both repos in the same round of changes.

Blog diagrams are React components, not images. Each one lives in
`apps/routecraft.dev/app/components/figures/` and is registered by id in that folder's
`index.ts`. A figure is drawn on a fixed canvas and scaled by `<ScaledFrame>`, so the
composition never reflows: the same drawing at every width, just smaller.

A figure is authored across two files. The **drawing** is the `.tsx`; its **words** (`alt`
and `caption`) live in `apps/routecraft.dev/app/components/figures/manifest.mjs`, keyed by id. That split exists because the
words have to be readable without loading JSX: the generator that writes `public/raw/**` and
the markdown cleaner both need them, and neither may pull a drawing's React tree into a Node
context. `apps/routecraft.dev/app/components/figures/index.ts` joins the two and throws if a
drawing has no entry, so the halves cannot drift apart silently.

Every figure ships in two resolutions, because it renders on surfaces with very different
size budgets:

- **`Figure`** is the full drawing. It renders in the browser only, so it may use grid and
  `color-mix`. Type and colour come from the `primitives.tsx` vocabulary and the `palette`
  prop, not from Tailwind classes, so the drawing stays self-contained and a subtree of it
  can be lifted into a motif. Place it with `<Diagram id="..." />` at the point in the
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

### In raw markdown, a figure is an image

`<Diagram />` is meaningless off the site, so `apps/routecraft.dev/app/lib/clean-mdx.ts` turns it into a real
markdown image of the light PNG, with the figure's `alt` and its caption in italics beneath.
That is what `public/raw/blog/<slug>.md` and the "copy page" button emit, so a cross-post to
dev.to or an LLM reading the raw file gets the artwork and a description rather than an
unresolved tag. The URL is absolute, because raw markdown is read away from the site where a
root-relative path resolves against the wrong host. An unknown figure id leaves the tag
untouched rather than emitting a link that 404s.

### At phone width, a figure is a picture

A 1600x900 drawing scaled into a 358px column is complete but unreadable, so `<Diagram />`
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

The PNGs are produced by `apps/routecraft.dev/scripts/export-figures.ts`, which serves the built export, drives
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
rather than built in CI so the release workflow never has to install a browser. The page and the script agree on
the output path and the screenshot marker through `apps/routecraft.dev/app/lib/figure-image.ts`; keep new
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

The changelog (`apps/routecraft.dev/app/content/changelog/index.mdx`) is for a user scanning to decide
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
their code finds it. Rely on the group-level `<Badge color="red">Breaking</Badge>` rather
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

## Docs channels: what is version-pinned and what is not

`/docs` publishes the **last released** version; `/docs/next` publishes main. The release
workflow snapshots main into `app/content/docs-next` and `public/screenshots/next`, then calls
`apps/routecraft.dev/scripts/freeze-docs.ts <tag>`, which wipes the pinned paths, checks them
out from the latest `v*` tag, and carries that snapshot across the swap. Everything else in the
site (home, blog, changelog, every route and every React component) always builds from main,
which is what lets a blog post ship without cutting a release.

Three rules follow, and all three have been violated before:

- **The freeze is a replace, not an overlay.** `git checkout <tag> -- <path>` restores what
  the tag carries and silently keeps anything added since, so pages written after the release
  used to publish on `/docs` as though they had shipped. The script wipes the paths first.
  Any future step that pins content to a ref must do the same.
- **Versioned content lives under `app/content/docs`, never in a component.** That is the
  whole rule, and it covers data as well as prose: the rows behind the reference catalogues
  (`OperationsIndex`, `AdapterGrid`, `PluginIndex`, `ErrorTable`, `EventNamespaces`) live in
  `app/content/docs/_data/*.json` and reach the components through
  `apps/routecraft.dev/app/lib/docs-catalogue.ts`. Row data held in a component is frozen by
  nothing, so an added entry publishes as released, an **edited description or signature
  rewrites released docs**, and a deleted entry vanishes from docs that still document it.
  Presence checks alone do not catch the middle case; only pinning the data does.
- **A row and its page are checked against each other.** `apps/routecraft.dev/scripts/generate-docs-catalogue.ts` fails
  the build when an operation, adapter, or plugin has no reference page, or an error code or
  event namespace has no heading to link to. On a channel that owns its data a mismatch is an
  authoring mistake, so it is an error, not a silently dropped row. Anchors are resolved
  through the catalogue rather than hand-built, because the heading `## RC1001` slugifies to
  `rc-1001`.

**The channel comes from the route, not from the page.** `/docs/$` and `/docs/next/$` are two
routes over two content roots, and each passes its channel into `MdxComponents`
(`app/components/mdx.tsx`), which puts it in context. The catalogue components read it there,
and `/docs/...` links written in content are rewritten to the reading channel by the provider's
link component. So the next channel is a **verbatim copy** of the pages
(`apps/routecraft.dev/scripts/generate-docs-next.ts`): nothing is injected into the markup, and
a page reads identically on both channels. Add a new reference catalogue and it needs a data
file under `_data`, an entry in `CATALOGUES`, and registration in the MDX provider wrapped in
`channelBound`, or it will dump `/docs/next` readers back onto the released channel.

**The pinned set is `PINNED` in `freeze-docs.ts`**, and nothing else. Today that is
`app/content/docs` (pages plus `_data`), `app/content/cheat-sheet`, and `public/screenshots`
(the only assets docs pages embed; `public/images` is blog-only). Anything a docs page renders
that is not in that list builds from main. When you add a surface the released channel must
pin, add it to that list and give it a next-channel mirror, the way screenshots have one. The
list in the script, the one the verify gate reads, and the one named here are one list.

**The sidebar and the raw mirror follow the channel too.** `apps/routecraft.dev/app/lib/navigation.ts` is shell, so
`Navigation` filters its entries against the channel's page set; an entry for an unreleased
page shows on next and never 404s on the released channel. `public/raw/**` mirrors both
channels (`/raw/docs/**` and `/raw/docs/next/**`, with whole-channel bundles at
`/raw/docs.md` and `/raw/docs-next.md`), because the in-development docs are what you hand a
model when testing against the canary. The next mirror stays out of `llms.txt` and the
sitemap, matching the channel's noindex.

**A deploy asserts all of this rather than trusting it.** `apps/routecraft.dev/scripts/verify-docs-freeze.ts`
runs after the build, against the prerender output in `.output/public`, and fails the deploy
when the published `/docs` routes are not exactly the freeze tag's page set, when the next
channel is empty, or when a next URL reaches the sitemap. It runs **before** the image is
pushed, so a freeze-shaped mistake never reaches the registry. If a released page needs fixing
before the next release, dispatch the workflow with `freeze_ref` rather than loosening the
freeze.

Two transitional wrinkles, both retired by the same event: the first release tag that carries
`app/content/docs`. Until then, tags cut before `_data` existed freeze a docs tree without it,
so that channel falls back to the repository's data pruned to the pages it documents
(`fallbackRows`); and tags cut before the content root moved carry Markdoc, which
`freezeLegacyTag` converts on the fly and the verify gate reads through its legacy page-file
name.

If historical majors ever ship (`/docs/v1` alongside latest and next), the successor design is
to build each channel from its own git ref and merge the exports. That is rejected today
because it would render the released channel with the released shell, which is exactly what
`MIN_FREEZE_VERSION` exists to avoid, and it doubles CI on every main push.

## Constrained MDX: content may only use registered components

Docs, blog and changelog pages are MDX, and the only components they may use are the ones
registered in the provider at `apps/routecraft.dev/app/components/mdx.tsx`. **No imports inside
a content file, and no ad-hoc inline JSX.** A component a page needs is added to the provider
first, with a name and props chosen for authors, and only then used in content.

The constraint is what keeps the other rules in this standard true:

- **Content is frozen, components are not.** A page is checked out from a release tag and
  rendered by a shell built from main. A page that imports a module pins itself to a path that
  may not exist at that ref, and the failure surfaces as a broken release build rather than
  where the edit was made.
- **The raw mirrors have to degrade to markdown.** `apps/routecraft.dev/app/lib/clean-mdx.ts`
  turns each page into plain markdown for `public/raw/**`, the "copy page" button and the LLM
  bundles, and a component name that survives that pass is fatal. Every registered component
  has a stand-in there; an ad-hoc one has none.
- **One vocabulary, one review surface.** The registered set is also what
  `scripts/convert-markdoc.ts` targets, so the transitional conversion of pre-migration tags
  fails loudly on anything outside it instead of shipping best-effort markup.

## Operational constraint: redirects

The site ships as a server (Nitro under Bun in the image), so a moved URL can be redirected by
the app itself and no longer needs host coordination. Still prefer repurposing a page in place
over moving or deleting its URL: inbound links and LLM-cached URLs outlive our routing. When a
URL must change, ship the redirect in the same change, and remember that the prerender list is
derived from the content tree (`contentRoutes` in `apps/routecraft.dev/vite.config.ts`), so a
redirect that is not backed by a content file has to be a route. Deep links are pinned outside
this repository in the trailing-slash form, which is part of the contract.
