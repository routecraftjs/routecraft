/**
 * Extracts comparable plain text from a captured HTML page.
 *
 * The acceptance harness compares rendered text between the live Next.js site
 * and the TanStack Start output. Markup differs between the two stacks by
 * definition, so the comparison is made on visible text only: scripts, styles
 * and all tags are removed, entities are decoded, and whitespace is collapsed.
 *
 * Usage: bun scripts/extract-text.ts <html-dir> <out-dir>
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { Glob } from 'bun'

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
  '#x2F': '/',
}

function decodeEntities(value: string): string {
  return value.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (match, entity: string) => {
      const named = ENTITIES[entity]
      if (named) return named
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
      }
      if (entity.startsWith('#')) {
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
      }
      return match
    },
  )
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

// Guarded so `htmlToText` can be imported by other scripts.
if (import.meta.main) {
  const [htmlDir, outDir] = process.argv.slice(2)

  if (!htmlDir || !outDir) {
    console.error('Usage: bun scripts/extract-text.ts <html-dir> <out-dir>')
    process.exit(1)
  }

  let count = 0

  for await (const file of new Glob('**/index.html').scan({
    cwd: htmlDir,
    absolute: true,
  })) {
    const text = htmlToText(await readFile(file, 'utf8'))
    const target = join(
      outDir,
      relative(htmlDir, file).replace(/index\.html$/, 'index.txt'),
    )
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${text}\n`)
    count += 1
  }

  console.log(`Extracted text from ${count} page(s)`)
}
