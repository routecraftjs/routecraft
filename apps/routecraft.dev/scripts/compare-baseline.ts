/**
 * Compares the built pages against the captured production pages.
 *
 * A page that renders but loses a chunk of its content is the failure mode this
 * migration is most exposed to: MDX silently drops what it does not understand,
 * and nothing errors. Word counts per page catch that class of defect the way
 * per-page eyeballing cannot.
 *
 * Differences are expected where main has moved on from the released tag, so
 * this reports and ranks rather than failing. Run it against a frozen build to
 * compare like for like.
 *
 * Usage: bun scripts/compare-baseline.ts [output-dir]
 */

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Glob } from 'bun'

import { htmlToText } from './extract-text'
import { ROOT } from './paths'

const outputDir = process.argv[2] ?? join(ROOT, '.output', 'public')
const baselineDir = join(ROOT, 'baseline', 'text')

interface Row {
  url: string
  baseline: number
  built: number
  delta: number
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

const rows: Row[] = []
const missing: string[] = []

for (const file of new Glob('**/index.txt').scanSync({ cwd: baselineDir })) {
  const url = `/${relative('.', file).replace(/index\.txt$/, '')}`
  // The capture fetched the llms bundles as pages; they are plain text files
  // served from public, not routes, so they have no built HTML to compare.
  if (/\.txt\/$/.test(url)) continue
  const built = join(outputDir, url, 'index.html')

  let builtText: string
  try {
    builtText = htmlToText(readFileSync(built, 'utf8'))
  } catch {
    missing.push(url)
    continue
  }

  const baseline = words(readFileSync(join(baselineDir, file), 'utf8'))
  const count = words(builtText)
  rows.push({ url, baseline, built: count, delta: count - baseline })
}

const shrunk = rows
  .filter((row) => row.delta < 0 && Math.abs(row.delta) / row.baseline > 0.05)
  .sort((a, b) => a.delta - b.delta)

console.log(`Compared ${rows.length} page(s) against the captured baseline.`)

if (missing.length > 0) {
  console.log(`\nNot built (${missing.length}):`)
  for (const url of missing.slice(0, 20)) console.log(`  ${url}`)
}

if (shrunk.length === 0) {
  console.log('\nNo page lost more than 5 percent of its words.')
} else {
  console.log(`\nPages that lost content (${shrunk.length}):`)
  for (const row of shrunk.slice(0, 30)) {
    const pct = Math.round((row.delta / row.baseline) * 100)
    console.log(
      `  ${row.url}  ${row.baseline} -> ${row.built} words (${pct} percent)`,
    )
  }
}
