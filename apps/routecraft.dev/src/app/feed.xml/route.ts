import { getAllBlogPosts } from '@/lib/blog'
import { absoluteUrl, siteDescription, siteName, siteUrl } from '@/lib/site'

export const dynamic = 'force-static'

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// RSS 2.0 feed of published blog posts. Static-exported at /feed.xml.
export function GET() {
  const posts = getAllBlogPosts().filter((post) => !post.draft)

  const items = posts
    .map((post) => {
      const link = absoluteUrl(post.href)
      const pubDate = new Date(post.date)
      const date = Number.isNaN(pubDate.getTime())
        ? ''
        : `<pubDate>${pubDate.toUTCString()}</pubDate>`
      const description = post.description
        ? `<description>${escapeXml(post.description)}</description>`
        : ''
      const categories = (post.tags ?? [])
        .map((tag) => `<category>${escapeXml(tag)}</category>`)
        .join('')
      return `<item><title>${escapeXml(post.title)}</title><link>${link}</link><guid isPermaLink="true">${link}</guid>${date}${description}${categories}</item>`
    })
    .join('')

  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${escapeXml(`${siteName} Blog`)}</title><link>${siteUrl}/blog/</link><atom:link href="${siteUrl}/feed.xml" rel="self" type="application/rss+xml"/><description>${escapeXml(siteDescription)}</description><language>en</language>${items}</channel></rss>`

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  })
}
