import fs from 'fs'
import path from 'path'
import type { MetadataRoute } from 'next'

import { getPublishedPosts, lastModifiedDate } from '@/lib/blog'
import { siteUrl } from '@/lib/site'

export const dynamic = 'force-static'

export const baseUrl = siteUrl

export default function sitemap(): MetadataRoute.Sitemap {
  const routes: MetadataRoute.Sitemap = []

  // Add home page
  routes.push({
    url: `${baseUrl}/`,
    lastModified: new Date(),
    changeFrequency: 'weekly',
    priority: 1.0,
  })

  // Helper to recursively collect all page.md files from docs
  function collectDocPages(
    baseDir: string,
    urlPrefix: string = '',
  ): Array<{ url: string; mtime: Date }> {
    const pages: Array<{ url: string; mtime: Date }> = []

    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(baseDir, entry.name)

        if (entry.isDirectory()) {
          // Check if this directory has a page.md
          const pagePath = path.join(fullPath, 'page.md')
          if (fs.existsSync(pagePath)) {
            const stat = fs.statSync(pagePath)
            const url = `${urlPrefix}/${entry.name}/`
            pages.push({
              url,
              mtime: stat.mtime,
            })
          }

          // Recursively collect pages from subdirectories
          const subPages = collectDocPages(
            fullPath,
            `${urlPrefix}/${entry.name}`,
          )
          pages.push(...subPages)
        }
      }
    } catch (error) {
      console.warn(`Could not read directory ${baseDir}:`, error)
    }

    return pages
  }

  // Collect all documentation pages. The /docs/next channel is noindex (an
  // in-development mirror of the latest docs), so it is excluded from the sitemap.
  const docsBaseDir = path.join(process.cwd(), 'src', 'app', 'docs')
  const docPages = collectDocPages(docsBaseDir, '/docs').filter(
    (page) => page.url !== '/docs/next' && !page.url.startsWith('/docs/next/'),
  )

  // Add docs landing page if it exists
  const docsLandingPage = path.join(
    process.cwd(),
    'src',
    'app',
    'docs',
    'page.md',
  )
  if (fs.existsSync(docsLandingPage)) {
    const stat = fs.statSync(docsLandingPage)
    routes.push({
      url: `${baseUrl}/docs/`,
      lastModified: stat.mtime,
      changeFrequency: 'weekly',
      priority: 0.9,
    })
  }

  // Add all collected doc pages
  for (const { url, mtime } of docPages) {
    routes.push({
      url: `${baseUrl}${url}`,
      lastModified: mtime,
      changeFrequency: 'monthly',
      priority: 0.8,
    })
  }

  // Add the blog landing page and individual posts. Use the blog library so
  // unpublished (published: false) and draft posts are excluded.
  const blogBaseDir = path.join(process.cwd(), 'src', 'app', 'blog')
  if (fs.existsSync(blogBaseDir)) {
    routes.push({
      url: `${baseUrl}/blog/`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.9,
    })

    // lastmod comes from the post's `updated` (falling back to `date`), not the
    // file mtime: a fresh CI checkout resets every file's mtime to build time,
    // which would tell crawlers every post changed on every deploy. A malformed
    // date is omitted rather than passed on as an Invalid Date, which would make
    // Next throw while serialising lastmod and fail the whole sitemap build.
    // Cross-posts (frontmatter `canonical` pointing at another site) are
    // skipped: their pages canonicalise elsewhere, so listing them here would
    // claim URLs the site tells crawlers not to index in our favour.
    for (const post of getPublishedPosts().filter((p) => !p.canonical)) {
      const lastModified = new Date(lastModifiedDate(post))
      routes.push({
        url: `${baseUrl}/blog/${post.slug}/`,
        ...(Number.isNaN(lastModified.getTime()) ? {} : { lastModified }),
        changeFrequency: 'monthly',
        priority: 0.7,
      })
    }
  }

  // Add the cheat sheet reference page
  routes.push({
    url: `${baseUrl}/cheat-sheet/`,
    lastModified: new Date(),
    changeFrequency: 'monthly',
    priority: 0.8,
  })

  // Add the changelog (top-level, outside the versioned docs tree)
  routes.push({
    url: `${baseUrl}/changelog/`,
    lastModified: new Date(),
    changeFrequency: 'weekly',
    priority: 0.7,
  })

  // Add raw markdown files for AI crawlers and direct access. The raw files
  // of cross-posted blog articles are skipped like their HTML pages: the
  // article's canonical home is elsewhere, so this site should not offer the
  // content for indexing (the file itself stays served, with its attribution
  // line, for readers and direct links).
  const crossPostRawUrls = new Set(
    getPublishedPosts()
      .filter((post) => post.canonical)
      .map((post) => `/raw/blog/${post.slug}.md`),
  )
  const rawDir = path.join(process.cwd(), 'public', 'raw')
  const rawPages = collectRawMarkdown(rawDir, '/raw').filter(
    ({ url }) =>
      !crossPostRawUrls.has(url) &&
      // The in-development channel is noindex, and its raw mirror follows the
      // same rule as its HTML: served for anyone who asks, never advertised.
      !url.startsWith('/raw/docs/next/') &&
      url !== '/raw/docs/next.md' &&
      url !== '/raw/docs-next.md',
  )
  for (const { url, mtime } of rawPages) {
    routes.push({
      url: `${baseUrl}${url}`,
      lastModified: mtime,
      changeFrequency: 'monthly',
      priority: 0.6,
    })
  }

  // Add llms.txt and llms-full.txt
  routes.push({
    url: `${baseUrl}/llms.txt`,
    lastModified: new Date(),
    changeFrequency: 'weekly',
    priority: 0.7,
  })
  routes.push({
    url: `${baseUrl}/llms-full.txt`,
    lastModified: new Date(),
    changeFrequency: 'weekly',
    priority: 0.7,
  })

  return routes
}

function collectRawMarkdown(
  dir: string,
  urlPrefix: string,
): Array<{ url: string; mtime: Date }> {
  const pages: Array<{ url: string; mtime: Date }> = []
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        pages.push(
          ...collectRawMarkdown(fullPath, `${urlPrefix}/${entry.name}`),
        )
      } else if (entry.name.endsWith('.md')) {
        const stat = fs.statSync(fullPath)
        pages.push({ url: `${urlPrefix}/${entry.name}`, mtime: stat.mtime })
      }
    }
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === 'ENOENT'
    ) {
      // Ignore missing directories
    } else {
      throw err
    }
  }
  return pages
}
