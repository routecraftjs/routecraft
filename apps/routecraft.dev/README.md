# routecraft.dev

The Routecraft website: home, docs, blog, changelog and cheat sheet. TanStack Start on Vite,
rendered by Nitro, shipped as a container image that Dokploy pulls.

## Layout

| Path | What lives there |
| --- | --- |
| `app/content/` | Authored content: `docs/`, `blog/`, `changelog/`, `cheat-sheet/`. MDX plus the reference row data under `docs/_data/` |
| `app/routes/` | The route tree. `/docs/$` and `/docs/next/$` are the two docs channels |
| `app/components/` | Shell and the MDX component vocabulary (`mdx.tsx`) content may use |
| `app/lib/` | Content loading, navigation, search, raw-markdown cleaning |
| `scripts/` | Generators, the release freeze, the freeze verification, figure export |
| `public/` | Static assets. `screenshots/` is versioned docs content; `images/` is blog-only |

Content may only use the components registered in `app/components/mdx.tsx`: no imports inside a
content file and no ad-hoc inline JSX. See
[`.standards/content-and-docs.md`](../../.standards/content-and-docs.md) for why, and for how
`/docs` and `/docs/next` are kept apart.

## Running the site

From the repository root:

```sh
bun install
bun run docs          # or: bun run dev, from this directory
```

Dev runs the generators first and then Vite, and prints the local URL.

## Generators

Everything derived from content is generated into gitignored paths, so a stale checkout never
serves stale derivatives. `bun run generate` runs all three, and `dev` and `build` run it for
you:

| Script | Writes | Purpose |
| --- | --- | --- |
| `scripts/generate-docs-next.ts` | `app/content/docs-next/`, `public/screenshots/next/` | The in-development channel: a verbatim copy of the docs tree |
| `scripts/generate-docs-catalogue.ts` | `app/lib/generated/` | The reference catalogues from `docs/_data/*.json`, checked against the pages that document them |
| `scripts/generate-raw-docs.ts` | `public/raw/`, `public/llms*.txt` | The plain-markdown mirrors and the LLM bundles |
| `scripts/generate-og-images.ts` | `public/og/` | Social preview images and the manifest the page heads read |
| `scripts/generate-sitemap.ts` | `public/sitemap.xml` | Indexable URLs, minus the noindex surfaces |
| `scripts/generate-robots.ts` | `public/robots.txt` | Crawler policy |
| `scripts/generate-feed.ts` | `public/feed.xml` | The blog RSS feed |

A frozen docs tree is never copied into the next channel: `generate-docs-next.ts` reads the
`.frozen` marker the freeze leaves and keeps the snapshot the freeze took from main. Copying
the frozen tree would publish the released docs on both channels, so the script fails rather
than guess when the marker is there and no snapshot is.

Figures are exported separately and committed, because the site serves the PNGs:

```sh
bunx playwright install chromium   # once
bun run build && bun run figures:export
```

## The local production check

What CI does, on your machine. Run it before merging anything that touches the release path:
the freeze, the generators, the prerender list, or the Dockerfile. From this directory:

```sh
bun scripts/freeze-docs.ts v0.6.0                 # snapshot main, then pin /docs to the tag
docker build -f Dockerfile -t routecraft-dev ../..
docker run --rm -p 3000:3000 routecraft-dev
bun scripts/freeze-docs.ts --restore              # put the working tree back
```

Notes on each step:

- The freeze rewrites `app/content/docs`, `app/content/cheat-sheet` and `public/screenshots` in
  place, so **`--restore` is not optional**; run it before you commit anything.
- The freeze takes the next-channel snapshot itself, from main, before it pins anything. There
  is no separate generate step to remember and no flag to pass to the build.
- The build context is the repository root (`../..`), because the site is a workspace member and
  the lockfile lives there.
- The image serves on port 3000. Check both `/docs` (the tag's pages) and `/docs/next` (main's).
- `VITE_BASE_URL` is the origin every absolute URL carries: canonicals, the sitemap, the feed and
  the social card links. It defaults to `https://routecraft.dev`, so a local image advertises card
  images the deployed site does not have yet and no preview resolves. `compose.yaml` defaults it to
  the host it serves on instead; with `docker build`, pass
  `--build-arg VITE_BASE_URL=http://localhost:3000` to check cards locally. The build prints the
  origin it used.
- `bun scripts/verify-docs-freeze.ts v0.6.0` asserts exactly that split against `.output/public`
  after a plain `bun run build`, and is what gates the deploy.

For a production build without Docker, `bun run build` then `bun run start`.

> `--restore` checks the versioned paths out of `HEAD`, so it discards
> uncommitted content edits along with the freeze. Commit content work before
> freezing.

## Checks

```sh
bun run typecheck
bun run lint
bun run test         # Playwright, against a server you have already started
bun run check:links  # internal links, against .output/public
```

`test` and `check:links` read the built site, so run `bun run build` and
`bun run start` first. The acceptance suite compares against `baseline/`, which
is what production served before the migration; point it elsewhere with
`BASE_URL=https://routecraft.dev bun run test`.
