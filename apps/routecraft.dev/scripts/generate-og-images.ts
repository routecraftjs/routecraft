#!/usr/bin/env bun

/**
 * Renders the site's Open Graph images to `public/og/` and writes the manifest
 * the page heads read.
 *
 *   public/og/index.png            the site card (home, docs, cheat sheet, blog index)
 *   public/og/blog/<slug>.png      one per blog post
 *   app/lib/generated/og-images.ts the URLs, with a content hash for cache busting
 *
 * The Next build served these from `/blog/<slug>/opengraph-image?<hash>`, a
 * route that rendered on demand. A static export has no such route, so the URLs
 * are different by design; the images themselves are the same design at the
 * same 1200x630 size.
 *
 * Fonts come from jsDelivr's fontsource mirror and are cached under
 * `node_modules/.cache/`, so a rebuild does not depend on the network.
 *
 * Run as: bun scripts/generate-og-images.ts
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createElement, type ReactElement } from 'react'

import { Resvg } from '@resvg/resvg-js'
import satori from 'satori'

import {
  BlogCover,
  COVER_HEIGHT,
  COVER_WIDTH,
} from '../app/components/BlogCover'
import { SiteCover } from '../app/components/SiteCover'
import { type BlogPostMeta, getAllPosts, getPublishedPosts } from './blog-posts'
import { GENERATED_DIR, PUBLIC_DIR, ROOT } from './paths'

const OUT_DIR = path.join(PUBLIC_DIR, 'og')
interface FontSpec {
  name: string
  style: 'normal' | 'italic'
  weight: 400 | 700
  /** Module id of the face, resolved from the lockfile rather than the network. */
  file: string
}

/**
 * Faces are read from the Fontsource packages so an image build needs no
 * network. Fetching them at build time made every deploy depend on a CDN, and
 * the image build has no warm cache to fall back on.
 */
const FONTS: FontSpec[] = [
  {
    name: 'Fraunces',
    style: 'normal',
    weight: 400,
    file: '@fontsource/fraunces/files/fraunces-latin-400-normal.woff',
  },
  {
    name: 'Fraunces',
    style: 'normal',
    weight: 700,
    file: '@fontsource/fraunces/files/fraunces-latin-700-normal.woff',
  },
  {
    name: 'Fraunces',
    style: 'italic',
    weight: 400,
    file: '@fontsource/fraunces/files/fraunces-latin-400-italic.woff',
  },
  {
    name: 'JetBrains Mono',
    style: 'normal',
    weight: 400,
    file: '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff',
  },
]

function loadFont(spec: FontSpec): Buffer {
  return fs.readFileSync(Bun.resolveSync(spec.file, ROOT))
}

const fonts = await Promise.all(
  FONTS.map(async (spec) => ({
    name: spec.name,
    style: spec.style,
    weight: spec.weight,
    data: loadFont(spec),
  })),
)

async function renderPng(element: ReactElement): Promise<Buffer> {
  const svg = await satori(element, {
    width: COVER_WIDTH,
    height: COVER_HEIGHT,
    fonts,
  })
  // Satori embeds every glyph as a path, so the rasteriser needs no font of its
  // own. Keeping system fonts out also keeps the output identical across hosts.
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: COVER_WIDTH },
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng()
  return Buffer.from(png)
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  svg: 'image/svg+xml',
}

/**
 * The post's own artwork, letterboxed into the card. Only `/public`-rooted
 * paths are handled: an external URL would need a fetch and a CORS story that
 * a build step should not be taking on. Returns null when the file or its type
 * is not usable, so the caller falls back to the generated cover.
 */
async function renderCustomImage(imagePath: string): Promise<Buffer | null> {
  if (!imagePath.startsWith('/')) return null
  const absolute = path.join(PUBLIC_DIR, imagePath.slice(1))
  if (!fs.existsSync(absolute)) return null
  const mime = MIME_BY_EXT[path.extname(imagePath).slice(1).toLowerCase()]
  if (!mime) return null

  const dataUri = `data:${mime};base64,${fs.readFileSync(absolute).toString('base64')}`
  return renderPng(
    createElement(
      'div',
      {
        style: {
          display: 'flex',
          width: COVER_WIDTH,
          height: COVER_HEIGHT,
          backgroundColor: '#f5f1e8',
        },
      },
      createElement('img', {
        src: dataUri,
        width: COVER_WIDTH,
        height: COVER_HEIGHT,
        alt: '',
        style: { objectFit: 'cover' },
      }),
    ),
  )
}

/**
 * The post's figure number, ascending by publish date across the whole blog.
 * It is global rather than per-tag so the covers read as one numbered series.
 */
const figureNumbers = new Map<string, number>(
  [...getPublishedPosts()]
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .map((post, index) => [post.slug, index + 1]),
)

async function renderPost(post: BlogPostMeta): Promise<Buffer> {
  // The post's own image wins when it has one (AI-generated, hand-crafted,
  // photo). The drawn cover is the fallback.
  if (post.image) {
    const custom = await renderCustomImage(post.image)
    if (custom) return custom
  }

  return renderPng(
    createElement(BlogCover, {
      title: post.title,
      slug: post.slug,
      tags: post.tags,
      subtitle: post.description,
      glyph: post.coverGlyph,
      diagram: post.diagram,
      figureNumber: figureNumbers.get(post.slug) ?? figureNumbers.size + 1,
    }),
  )
}

/** Writes the PNG and returns its public URL, fingerprinted for cache busting. */
function write(relativePath: string, png: Buffer): string {
  const outPath = path.join(OUT_DIR, relativePath)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, png)
  const hash = createHash('sha256').update(png).digest('hex').slice(0, 16)
  return `/og/${relativePath}?${hash}`
}

// The directory is rewritten from scratch each run so a renamed or deleted post
// leaves no orphan card behind for a stale link to keep resolving.
fs.rmSync(OUT_DIR, { recursive: true, force: true })

const rootUrl = write('index.png', await renderPng(createElement(SiteCover)))

const posts = getAllPosts()
const byPost: Array<[string, string]> = []
for (const post of posts) {
  byPost.push([
    post.slug,
    write(`blog/${post.slug}.png`, await renderPost(post)),
  ])
}
byPost.sort(([a], [b]) => a.localeCompare(b))

const manifest =
  [
    '// Generated by scripts/generate-og-images.ts -- do not edit by hand.',
    '// The PNGs live in public/og/ and are regenerated by `bun run generate`.',
    '',
    '/** Open Graph card dimensions. Every card is rendered at this size. */',
    `export const OG_IMAGE_WIDTH = ${COVER_WIDTH}`,
    `export const OG_IMAGE_HEIGHT = ${COVER_HEIGHT}`,
    `export const OG_IMAGE_TYPE = ${JSON.stringify('image/png')}`,
    '',
    '/** The site card, used by every page that has no card of its own. */',
    `export const rootOgImage = ${JSON.stringify(rootUrl)}`,
    '',
    '/** Per-post cards, keyed by slug. */',
    'export const blogOgImages: Record<string, string> = {',
    ...byPost.map(
      ([slug, url]) => `  ${JSON.stringify(slug)}: ${JSON.stringify(url)},`,
    ),
    '}',
    '',
    '/** The card for a post, falling back to the site card for an unknown slug. */',
    'export function blogOgImage(slug: string): string {',
    '  return blogOgImages[slug] ?? rootOgImage',
    '}',
  ].join('\n') + '\n'

fs.mkdirSync(GENERATED_DIR, { recursive: true })
fs.writeFileSync(path.join(GENERATED_DIR, 'og-images.ts'), manifest, 'utf8')

console.log(
  `Generated ${byPost.length + 1} OG image(s) in public/og/ and app/lib/generated/og-images.ts`,
)
