#!/usr/bin/env bun

/**
 * Writes `public/robots.txt`.
 *
 * The policy is fully permissive: nothing on the site is hidden from crawlers
 * by robots.txt. Pages that must stay out of search results (the `/docs/next`
 * channel, drafts) carry their own `noindex` meta and are absent from the
 * sitemap, which is the mechanism that actually keeps them unindexed. A
 * `Disallow` here would instead stop crawlers from ever reading that meta.
 *
 * Run as: bun scripts/generate-robots.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { siteUrl } from '../app/lib/site'
import { PUBLIC_DIR } from './paths'

const robots =
  [
    'User-Agent: *',
    'Allow: /',
    '',
    `Host: ${siteUrl}`,
    `Sitemap: ${siteUrl}/sitemap.xml`,
  ].join('\n') + '\n'

const outPath = path.join(PUBLIC_DIR, 'robots.txt')
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, robots, 'utf8')

console.log('Generated public/robots.txt')
