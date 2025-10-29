import fs from 'fs'
import path from 'path'
import type { MetadataRoute } from 'next'

export const dynamic = 'force-static'

export const baseUrl =
  process.env.NEXT_PUBLIC_BASE_URL || 'https://routecraft.dev'

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

  // Collect all documentation pages
  const docsBaseDir = path.join(process.cwd(), 'src', 'app', 'docs')
  const docPages = collectDocPages(docsBaseDir, '/docs')

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

  return routes
}
