#!/usr/bin/env bun

/**
 * Writes `public/feed.xml`, the RSS 2.0 feed of published blog posts.
 *
 * Cross-posts are included: a reader subscribed to this feed should see every
 * article the blog publishes. That is the opposite of the sitemap's rule, which
 * is about which URL a search engine should credit, not about what a reader
 * gets.
 *
 * Run as: bun scripts/generate-feed.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  absoluteUrl,
  siteDescription,
  siteName,
  siteUrl,
} from '../app/lib/site'
import { getPublishedPosts } from './blog-posts'
import { PUBLIC_DIR } from './paths'

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const items = getPublishedPosts()
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

const outPath = path.join(PUBLIC_DIR, 'feed.xml')
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, xml, 'utf8')

console.log(
  `Generated public/feed.xml with ${getPublishedPosts().length} items`,
)
