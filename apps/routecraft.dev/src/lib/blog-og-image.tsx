import fs from 'fs/promises'
import path from 'path'

import { ImageResponse } from 'next/og'

import { BlogCover, COVER_HEIGHT, COVER_WIDTH } from '@/components/BlogCover'
import { getAllBlogPosts, getBlogPostBySlug } from '@/lib/blog'

export const OG_SIZE = { width: COVER_WIDTH, height: COVER_HEIGHT }
export const OG_CONTENT_TYPE = 'image/png'

const FONT_URLS = {
  fraunces:
    'https://cdn.jsdelivr.net/fontsource/fonts/fraunces@latest/latin-400-normal.ttf',
  fraunces700:
    'https://cdn.jsdelivr.net/fontsource/fonts/fraunces@latest/latin-700-normal.ttf',
  fraunces400i:
    'https://cdn.jsdelivr.net/fontsource/fonts/fraunces@latest/latin-400-italic.ttf',
  mono: 'https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-400-normal.ttf',
} as const

let cachedFonts: Awaited<ReturnType<typeof loadFontsUncached>> | null = null

async function loadFontsUncached() {
  const [fraunces, fraunces700, fraunces400i, mono] = await Promise.all(
    (
      [
        FONT_URLS.fraunces,
        FONT_URLS.fraunces700,
        FONT_URLS.fraunces400i,
        FONT_URLS.mono,
      ] as const
    ).map(async (url) => {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(
          `Failed to fetch font ${url}: ${response.status} ${response.statusText}`,
        )
      }
      return response.arrayBuffer()
    }),
  )
  return { fraunces, fraunces700, fraunces400i, mono }
}

async function loadFonts() {
  if (!cachedFonts) cachedFonts = await loadFontsUncached()
  return cachedFonts
}

function figureNumberFor(slug: string): number {
  const posts = getAllBlogPosts()
    .filter((post) => !post.draft)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
  const index = posts.findIndex((post) => post.slug === slug)
  return index >= 0 ? index + 1 : posts.length + 1
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

async function renderCustomImageAsOg(
  imagePath: string,
): Promise<Response | null> {
  // Only handle local /public-rooted images. External URLs would need a runtime
  // fetch and a tighter CORS story; out of scope here.
  if (!imagePath.startsWith('/')) return null
  const abs = path.join(process.cwd(), 'public', imagePath.slice(1))
  let buffer: Buffer
  try {
    buffer = await fs.readFile(abs)
  } catch {
    return null
  }
  const ext = path.extname(imagePath).slice(1).toLowerCase()
  const mime = MIME_BY_EXT[ext]
  if (!mime) return null
  const dataUri = `data:${mime};base64,${buffer.toString('base64')}`

  const fonts = await loadFonts()
  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        width: OG_SIZE.width,
        height: OG_SIZE.height,
        backgroundColor: '#f5f1e8',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={dataUri}
        width={OG_SIZE.width}
        height={OG_SIZE.height}
        alt=""
        style={{ objectFit: 'cover' }}
      />
    </div>,
    {
      ...OG_SIZE,
      fonts: [
        {
          name: 'Fraunces',
          data: fonts.fraunces,
          style: 'normal',
          weight: 400,
        },
      ],
    },
  )
}

export interface BlogOgImageOptions {
  slug: string
}

export async function createBlogOgImage({
  slug,
}: BlogOgImageOptions): Promise<Response> {
  const post = getBlogPostBySlug(slug)
  if (!post) {
    throw new Error(
      `Cannot generate OG image: no blog post with slug "${slug}"`,
    )
  }

  // Prefer the post's own image when set (AI-generated, hand-crafted, photo).
  // The generated cover is the fallback for posts without one.
  if (post.image) {
    const response = await renderCustomImageAsOg(post.image)
    if (response) return response
  }

  const fonts = await loadFonts()
  const figureNumber = figureNumberFor(slug)

  return new ImageResponse(
    <BlogCover
      title={post.title}
      slug={post.slug}
      tags={post.tags}
      subtitle={post.description}
      glyph={post.coverGlyph}
      figureNumber={figureNumber}
    />,
    {
      ...OG_SIZE,
      fonts: [
        {
          name: 'Fraunces',
          data: fonts.fraunces,
          style: 'normal',
          weight: 400,
        },
        {
          name: 'Fraunces',
          data: fonts.fraunces700,
          style: 'normal',
          weight: 700,
        },
        {
          name: 'Fraunces',
          data: fonts.fraunces400i,
          style: 'italic',
          weight: 400,
        },
        {
          name: 'JetBrains Mono',
          data: fonts.mono,
          style: 'normal',
          weight: 400,
        },
      ],
    },
  )
}
