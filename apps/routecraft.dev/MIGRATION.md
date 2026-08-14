# routecraft.dev migration: Next.js to TanStack Start (v2, execution)

Working document for the migration branch. Supersedes the v1 plan. It records the
rulings taken before implementation started, the corrections that came out of
validating v1 against this repository, and the acceptance baselines.

The durable rules now live in `.standards/content-and-docs.md`, the app README
and `DEFINITION_OF_DONE.md`. What remains here is why the migration was shaped
this way, and the two transitional mechanisms that retire together at the first
post-migration tag.

## Base commit

`ae7987271613ffa6ca19e4cc71ff6e946a4421a7` (`fix(docs): pin the released docs channel to what the release actually shipped (#597)`).

Docs authored on main after this commit are re-synced with `scripts/convert-markdoc.ts`
rather than rebased. See "Re-syncing docs written during the window" below.

## Rulings

### R1. The migration merges when it is green, not when 0.7.0 ships

The latest eligible freeze tag is `v0.6.0`, which carries Markdoc `page.md` at
the pre-migration paths. Rather than hold the branch until 0.7.0 tags, the freeze
step gains a transitional branch:

- Tag carries `apps/routecraft.dev/app/content/docs`: plain checkout, today's behaviour.
- Tag does not carry it: check out the tag's `src/app/docs`, `src/app/cheat-sheet`
  and `public/screenshots`, then run `scripts/convert-markdoc.ts` over the checked-out
  tree to produce the content root the new stack expects.

The shim is deleted together with the `fallbackRows` transitional path in
`generate-docs-catalogue.ts`, at the same moment, once the oldest freezable tag
carries the new content root. Issue #600 is the natural home for that cleanup.

Verified end to end against the real `v0.6.0` tag: 119 released pages converted
from Markdoc, 121 on the next channel from main, unreleased pages absent from
`/docs` and present on `/docs/next`, the deploy gate green, and the published
URL set identical to the captured production sitemap.

### R2. The cheat sheet stays version-pinned

It was in the freeze path list and stays in it, now as
`app/content/cheat-sheet`, so it freezes like any other versioned content.

Transitional caveat, for the window between this merge and the v0.7.0 tag: v0.6.0
carries only the old `.tsx`, so the released cheat sheet renders from main's
migrated copy. Cheat-sheet content edits during that window would surface on
`/docs` before their release. Hold cheat-sheet edits until 0.7.0.

### R3. GH Pages is deleted in this PR, DNS flips right after the first green deploy

Deleting the Pages deploy does not take the Pages site down, it stops updating it.
The old deployment keeps serving until the Cloudflare origin is repointed, which
is a maintainer action taken as soon as the first Dokploy deploy is verified
healthy. No dual-publishing period is designed for.

### R4. The image is pushed to GHCR

Registry push from the workflow, Dokploy pulls by tag. The image is the rollback
unit, so rollback is redeploying the previous tag. Dokploy-side builds cannot
offer that.

### R5. Deploy cadence is unchanged: every push to main

Today `build-and-deploy-docs` runs on every main push, which is what keeps the
blog and `/docs/next` fresh between releases. The new workflow keeps that: every
main push builds and deploys an image, with `/docs` frozen to the latest eligible
tag and the next channel plus blog from main.

## Corrections to v1

Validated against the repository. Each of these was wrong or unsupported in v1.

| v1 claim | Reality | Consequence |
| --- | --- | --- |
| "Port the existing broken-link checker" | No link checker exists anywhere in the repo | It must be written, not ported |
| "Replaces the current multi-step freeze simulation" | No local freeze procedure is documented; the app README is the stock Tailwind template | The simple local path is new work, not a replacement |
| Raw mirrors are clean markdown today | `raw/docs.md` on production contains literal Markdoc: the five reference index tags, one `callout`, one `topology-diagram` | See "Raw mirror fidelity" below |
| Fallback deletion is scheduled at 0.7.0 in the script header | The header states a condition, not a version. The 0.7.0 framing comes from issue #600 | Follow the condition |
| Tailwind config assumptions | Tailwind 4 (no `tailwind.config.js`), Next 16, React 19 | `@tailwindcss/vite`, matching the reference stack |
| "Two next/font imports" | One import statement, three font families | Three font families to port |
| "The only async components are opengraph-image files" | `src/app/figures/[id]/page.tsx` is also async; only one `opengraph-image.tsx` is committed, the per-post ones are generated shims | Figures route needs the same treatment |
| Content is docs and blog | `src/app/changelog/page.md` is also Markdoc, and is the sole user of the `badge` tag | Changelog is in conversion scope |
| Freeze path list is docs content plus screenshots | It also carries the cheat sheet, and the old freeze had to restore a `docs/changelog` redirect stub that lived inside the pinned tree | The stub is now a route rather than content, so the exception is gone; `/docs/changelog` is a server redirect |

Sizing figures in v1 (tag instance counts) were measured against a built tree
with the generated `docs/next` copy present and counted closing tags. They are
inflated two to four times. The tag inventory itself is complete: no tag appears
in content that v1 does not list, so conversion scope is correctly bounded.

## Raw mirror fidelity

Master rule 8 requires the mirrors to diff clean against baseline, and separately
requires "no component syntax". Production output satisfies neither claim fully:
the current cleaner has no handling for the five reference index tags, and misses
one `callout` and one `topology-diagram` instance.

Ruling: the new cleaner renders those tags properly rather than reproducing the
leak. That is a deliberate, listed difference from baseline, and the only one
permitted in the raw-mirror diff. Every other difference is a defect.

## Acceptance baselines

Captured from production before any change, in `apps/routecraft.dev/baseline/`:

- `sitemap.xml`, `urls-sitemap.txt` (250 URLs), `urls-pages.txt` (127 pages)
- `html/**/index.html`, every live page as served
- `anchors.txt`, heading ids per page, derived from the HTML
- `raw/**`, all 123 per-page mirrors plus `raw/docs.md` and `raw/docs-next.md`
- `llms.txt`, `llms-full.txt`, `llms-full-next.txt`

The directory stays committed: `tests/acceptance.spec.ts` reads the URL and
anchor baselines from it on every run, so it is part of the suite rather than
scaffolding. It is also the only record of what production served once DNS
moves off GitHub Pages.

## Re-syncing docs written during the window

Feature work continues on main while this branch is open, and those features ship
with docs. Rebasing Markdoc edits onto converted MDX files will conflict, so the
resync is a re-conversion, not a merge:

1. `git diff --name-status ae79872..main -- apps/routecraft.dev/src/app/docs apps/routecraft.dev/src/app/blog`
2. Run `scripts/convert-markdoc.ts` over exactly the added and modified files.
3. Write the output into the new content root, and delete the converted sources.

`_data/*.json` and navigation config are plain data and merge normally. New
Markdoc tags introduced during the window need a matching MDX component, and the
converter fails loudly on any tag it does not know, so they cannot pass silently.

Re-conversion overwrites the file, so a content fix made on this branch is lost
if main later touches the same page. This branch carries five anchor fixes that
main does not have; `bun run check:links` catches their loss, and the resync is
not finished until it is green again.

The converter has to survive until 0.7.0 anyway for the R1 freeze shim, so this
is a supported operation rather than a one-off migration hack.
