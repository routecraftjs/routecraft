/**
 * Materialises the per-channel reference catalogues under app/lib/generated/:
 * the rows each docs channel's own data files declare, plus the heading anchors
 * the rows link into.
 *
 * WHY THIS EXISTS
 *
 * /docs publishes the last released version and /docs/next publishes main, but
 * both are one build, and the components that render the reference tables are
 * part of the site shell, which is never frozen to the released tag. Any row
 * data held inside those components therefore describes main on both channels:
 * an operation added after the release is published as though it shipped, a
 * description edited on main rewrites released docs, and an entry deleted on
 * main vanishes from docs that still document it.
 *
 * So the rows are not held in the components. They live in
 * app/content/docs/_data/*.json, inside the tree the release freeze replaces,
 * and generate-docs-next.ts copies them into the next channel alongside the
 * pages. This script reads whichever copy each channel carries and emits it as
 * a typed module per catalogue (one file each, so a page only bundles its own
 * rows).
 *
 * A row and its page are checked against each other: every operation, adapter,
 * and plugin must have a reference page on its channel, and every error code
 * and event namespace must have a heading to link to. A mismatch fails the
 * build rather than silently dropping the row, because on the channels that own
 * their data a mismatch is an authoring error, not a version difference.
 *
 * THE FALLBACK
 *
 * Releases tagged before _data existed freeze a docs tree with no data files at
 * all. Rather than publish empty tables, such a channel falls back to the
 * repository's own data, pruned to the entries that channel documents: the
 * pages are still frozen, so presence still tells us what shipped, and only
 * edits to a surviving row can leak. Remove `fallbackRows` (and this note) once
 * the oldest tag the release workflow will freeze carries app/content/docs/_data.
 *
 * The anchor map is keyed by the normalised heading text (lowercase,
 * alphanumeric only) and resolves to the id the MDX pipeline actually renders,
 * which is `slugifyWithCounter` of the heading (so `## RC1001` is `rc-1001`,
 * not `rc1001`). Callers therefore never hand-build an anchor.
 *
 * The output is gitignored and rebuilt on each prebuild. Run after
 * generate-docs-next.ts so the next channel is part of the walk, and after the
 * release freeze so the latest channel reflects the released tag.
 *
 * Run as: bun scripts/generate-docs-catalogue.ts
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Glob } from 'bun'
import { slugifyWithCounter } from '@sindresorhus/slugify'

import { anchorKey, slug } from '../app/lib/slug'

const ROOT = resolve(import.meta.dirname, '..')
const CONTENT_DIR = join(ROOT, 'app', 'content')
const DOCS_DIR = join(CONTENT_DIR, 'docs')
const NEXT_DIR = join(CONTENT_DIR, 'docs-next')
const DATA_DIR = join(DOCS_DIR, '_data')
const OUT_DIR = join(ROOT, 'app', 'lib', 'generated')

type ChannelName = 'latest' | 'next'

const CHANNELS: ChannelName[] = ['latest', 'next']

/** Each channel is a content tree of its own; the next one is generated. */
const CHANNEL_DIRS: Record<ChannelName, string> = {
  latest: DOCS_DIR,
  next: NEXT_DIR,
}

type CatalogueRow = Record<string, unknown>

type FieldKind = 'string' | 'string?' | 'boolean' | 'boolean?' | 'string[]'

interface Catalogue {
  file: string
  module: string
  typeName: string
  key: (row: CatalogueRow) => string
  /** The reference folder each row must have a page in. */
  page?: string
  /** The page each row must have a heading on. */
  anchorsIn?: string
  fields: Record<string, FieldKind>
}

/**
 * One catalogue per data file. `page` names the reference folder each row must
 * have a page in; `anchorsIn` names the page each row must have a heading on.
 * Exactly one of the two applies: a row either owns a page or is a section of
 * a shared page.
 */
const CATALOGUES: Catalogue[] = [
  {
    file: 'operations.json',
    module: 'operations',
    typeName: 'OperationRow',
    key: (row) => String(row.name),
    page: 'reference/operations',
    fields: {
      name: 'string',
      category: 'string',
      signature: 'string',
      description: 'string',
      planned: 'boolean?',
    },
  },
  {
    file: 'adapters.json',
    module: 'adapters',
    typeName: 'AdapterRow',
    key: (row) => String(row.name),
    page: 'reference/adapters',
    fields: {
      name: 'string',
      category: 'string',
      roles: 'string[]',
      description: 'string',
    },
  },
  {
    file: 'plugins.json',
    module: 'plugins',
    typeName: 'PluginRow',
    key: (row) => String(row.name),
    page: 'reference/plugins',
    fields: {
      number: 'string',
      name: 'string',
      module: 'string',
      hint: 'string',
      description: 'string',
    },
  },
  {
    file: 'errors.json',
    module: 'errors',
    typeName: 'ErrorRow',
    key: (row) => String(row.code),
    anchorsIn: 'reference/errors',
    fields: {
      code: 'string',
      category: 'string',
      message: 'string',
      retryable: 'boolean',
    },
  },
  {
    file: 'events.json',
    module: 'events',
    typeName: 'EventNamespaceRow',
    key: (row) => String(row.anchor),
    anchorsIn: 'reference/events',
    fields: {
      pattern: 'string',
      events: 'string[]',
      anchor: 'string',
      note: 'string?',
    },
  },
]

// --- Heading anchors ----------------------------------------------------------

/** A trailing `\{#custom-id}` marker, escaped in content because MDX reads `{` as an expression. */
const EXPLICIT_ID = /\s*\\?\{#([\w-]+)\}\s*$/

function runLength(source: string, index: number, char: string): number {
  let length = 0
  while (source[index + length] === char) length += 1
  return length
}

/** Index just past the construct opened at `start`, or -1 when it never closes. */
function endOfCodeSpan(source: string, start: number): number {
  const ticks = runLength(source, start, '`')
  for (let i = start + ticks; i < source.length; i += 1) {
    if (source[i] !== '`') continue
    const run = runLength(source, i, '`')
    if (run === ticks) return i + run
    i += run - 1
  }
  return -1
}

function endOfBalanced(
  source: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '\\') {
      i += 1
      continue
    }
    if (source[i] === open) depth += 1
    else if (source[i] === close) {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

function endOfLink(source: string, start: number): number {
  const label = endOfBalanced(
    source,
    source[start] === '!' ? start + 1 : start,
    '[',
    ']',
  )
  if (label === -1) return -1
  if (source[label] === '(') return endOfBalanced(source, label, '(', ')')
  if (source[label] === '[') return endOfBalanced(source, label, '[', ']')
  return -1
}

const TAG_NAME = /^<\/?([A-Za-z][\w.-]*)/

function endOfElement(source: string, start: number): number {
  const name = TAG_NAME.exec(source.slice(start))?.[1]
  if (!name) return -1
  const tagEnd = source.indexOf('>', start)
  if (tagEnd === -1) return -1
  if (source[start + 1] === '/' || source[tagEnd - 1] === '/') return tagEnd + 1

  const closing = `</${name}>`
  const closingAt = source.indexOf(closing, tagEnd + 1)
  return closingAt === -1 ? tagEnd + 1 : closingAt + closing.length
}

function endOfEmphasis(source: string, start: number): number {
  const marker = source[start]
  // Underscores inside a word (`snake_case`, `_data`) do not open emphasis.
  if (marker === '_' && /\w/.test(source[start - 1] ?? '')) return -1

  const run = runLength(source, start, marker)
  for (let i = start + run; i < source.length; i += 1) {
    if (source[i] === '\\') {
      i += 1
      continue
    }
    if (source[i] !== marker) continue
    if (runLength(source, i, marker) < run) continue
    return i + run
  }
  return -1
}

/**
 * The direct text children of a heading, joined the way the renderer joins
 * them.
 *
 * Everything else in a heading is an element, not text: inline code, links,
 * emphasis, components and expressions contribute nothing to the slug. See
 * app/lib/mdx-plugins.ts, which this reproduces.
 */
function headingText(source: string): string {
  const parts: string[] = []
  let text = ''
  let i = 0

  while (i < source.length) {
    const char = source[i]

    if (char === '\\' && i + 1 < source.length) {
      text += source[i + 1]
      i += 2
      continue
    }

    let end = -1
    if (char === '`') end = endOfCodeSpan(source, i)
    else if (char === '[' || (char === '!' && source[i + 1] === '['))
      end = endOfLink(source, i)
    else if (char === '<') end = endOfElement(source, i)
    else if (char === '{') end = endOfBalanced(source, i, '{', '}')
    else if (char === '*' || char === '_') end = endOfEmphasis(source, i)

    if (end !== -1) {
      parts.push(text)
      text = ''
      i = end
      continue
    }

    text += char
    i += 1
  }

  parts.push(text)
  return parts.filter(Boolean).join(' ')
}

/** A `#` line inside YAML frontmatter is a comment, not a heading. */
function withoutFrontmatter(mdx: string): string {
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---[^\n]*\r?\n/.exec(mdx)
  return frontmatter ? mdx.slice(frontmatter[0].length) : mdx
}

/**
 * Heading ids for a page, as the MDX pipeline renders them (see
 * app/lib/mdx-plugins.ts: an explicit `\{#id}` marker wins, and one
 * `slugifyWithCounter` per document fills in the rest).
 *
 * Parsed textually rather than through remark because bun's isolated linker
 * cannot resolve the self-referencing exports map in unist-util-visit-parents,
 * which every mdast walker in that pipeline pulls in.
 */
function pageAnchors(mdx: string): Record<string, string> {
  const slugify = slugifyWithCounter()
  const anchors: Record<string, string> = {}
  let inFence = false

  for (const line of withoutFrontmatter(mdx).split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    // Every level, not just h2 and below: one slugifyWithCounter runs per
    // document across all headings, so skipping h1 would shift the counter
    // suffixes on duplicate headings and hide a row documented by an h1.
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (!heading) continue

    const explicit = EXPLICIT_ID.exec(heading[1])
    const text = headingText(
      explicit ? heading[1].slice(0, explicit.index) : heading[1],
    ).trim()

    // The counter is consumed even for a heading whose text is empty and whose
    // id is therefore not recorded, because the renderer consumes it too.
    const id = explicit ? explicit[1] : slugify(text)
    if (!text) continue

    // anchorKey strips punctuation, so `RC1001` and `RC-1001` collide while
    // slugify gives them distinct ids. Overwriting would point a row at the
    // wrong section while documents() still called it documented.
    const key = anchorKey(text)
    if (key in anchors) {
      throw new Error(
        `Two headings on the same page normalise to the anchor key "${key}". ` +
          `Rename one so every row resolves to its own section.`,
      )
    }
    anchors[key] = id
  }

  return anchors
}

// --- Walk the pages of every channel -----------------------------------------

interface ChannelPages {
  routes: Set<string>
  anchors: Record<string, Record<string, string>>
}

const pages = Object.fromEntries(
  CHANNELS.map((channel) => [
    channel,
    { routes: new Set<string>(), anchors: {} },
  ]),
) as Record<ChannelName, ChannelPages>

const anchorRoutes = CATALOGUES.map((c) => c.anchorsIn).filter(Boolean)

for (const channel of CHANNELS) {
  const dir = CHANNEL_DIRS[channel]
  if (!existsSync(dir)) continue

  const files: string[] = []
  for await (const file of new Glob('**/index.mdx').scan({ cwd: dir })) {
    files.push(file)
  }

  for (const file of files.sort()) {
    const route = dirname(file).split(sep).join('/')
    pages[channel].routes.add(route)
    if (anchorRoutes.includes(route)) {
      pages[channel].anchors[route] = pageAnchors(
        await readFile(join(dir, file), 'utf8'),
      )
    }
  }
}

// --- Resolve each channel's rows ---------------------------------------------

/** The `_data` directory a channel carries, or null when it predates them. */
function dataDir(channel: ChannelName): string | null {
  const dir = join(CHANNEL_DIRS[channel], '_data')
  return existsSync(dir) ? dir : null
}

async function readRows(
  dir: string,
  catalogue: Catalogue,
): Promise<CatalogueRow[] | null> {
  const file = join(dir, catalogue.file)
  if (!existsSync(file)) return null
  return JSON.parse(await readFile(file, 'utf8')) as CatalogueRow[]
}

/** Whether a channel documents a row: its own page, or a heading on a shared one. */
function documents(
  channel: ChannelName,
  catalogue: Catalogue,
  row: CatalogueRow,
): boolean {
  if (catalogue.page) {
    return pages[channel].routes.has(
      `${catalogue.page}/${slug(catalogue.key(row))}`,
    )
  }
  const anchors =
    (catalogue.anchorsIn && pages[channel].anchors[catalogue.anchorsIn]) || {}
  return Boolean(anchors[anchorKey(catalogue.key(row))])
}

/**
 * Main's rows, from wherever they still exist.
 *
 * Not `DATA_DIR`: the freeze replaces the docs content wholesale, so on a tag
 * that predates _data that directory is gone by the time this runs, and reading
 * it yielded nothing at all. Main's copy survives at the next channel's _data,
 * which generate-docs-next.ts writes before the freeze and the workflow parks
 * across it.
 */
function repositoryDataDir(): string | undefined {
  return [DATA_DIR, join(NEXT_DIR, '_data')].find((dir) => existsSync(dir))
}

/** See "THE FALLBACK" above: prune main's rows to what this channel documents. */
async function fallbackRows(
  channel: ChannelName,
  catalogue: Catalogue,
): Promise<CatalogueRow[]> {
  const dir = repositoryDataDir()
  if (!dir) {
    throw new Error(
      `The ${channel} channel carries no ${catalogue.file} and none was found ` +
        `at ${DATA_DIR} or the next channel's copy. Publishing an empty ` +
        `reference table is never correct; fix the data before building.`,
    )
  }
  const rows = (await readRows(dir, catalogue)) ?? []
  return rows.filter((row) => documents(channel, catalogue, row))
}

function validate(
  channel: ChannelName,
  catalogue: Catalogue,
  rows: CatalogueRow[],
): void {
  const undocumented = rows.filter((row) => !documents(channel, catalogue, row))
  if (undocumented.length === 0) return

  const what = catalogue.page
    ? `has no page under ${catalogue.page}/`
    : `has no heading on ${catalogue.anchorsIn}`
  throw new Error(
    `${catalogue.file} on the ${channel} channel: ` +
      `${undocumented.map((row) => catalogue.key(row)).join(', ')} ${what}. ` +
      `Every row must be documented on its own channel.`,
  )
}

const resolved = Object.fromEntries(
  CHANNELS.map((channel) => [channel, {}]),
) as Record<ChannelName, Record<string, CatalogueRow[]>>
const fellBack: string[] = []

for (const channel of CHANNELS) {
  const dir = dataDir(channel)
  for (const catalogue of CATALOGUES) {
    const own = dir ? await readRows(dir, catalogue) : null
    if (own) {
      validate(channel, catalogue, own)
      resolved[channel][catalogue.module] = own
    } else {
      resolved[channel][catalogue.module] = await fallbackRows(
        channel,
        catalogue,
      )
      fellBack.push(`${channel}/${catalogue.module}`)
    }

    // An empty catalogue is never a legitimate outcome: every channel of this
    // site documents all five. It is, however, exactly what a broken data path
    // produces, and it publishes as a blank reference table with a green build.
    // The first version of the fallback above did precisely that, so the
    // invariant is asserted rather than assumed.
    if (resolved[channel][catalogue.module].length === 0) {
      throw new Error(
        `${catalogue.file} resolved to zero rows on the ${channel} channel. ` +
          `That would publish an empty reference table.`,
      )
    }
  }
}

// --- Emit ---------------------------------------------------------------------

const FIELD_TYPES: Record<FieldKind, string> = {
  string: 'string',
  'string?': 'string | undefined',
  boolean: 'boolean',
  'boolean?': 'boolean | undefined',
  'string[]': 'string[]',
}

function rowInterface(catalogue: Catalogue): string {
  const fields = Object.entries(catalogue.fields)
    .map(([name, kind]) => {
      const optional = kind.endsWith('?')
      return `  ${name}${optional ? '?' : ''}: ${FIELD_TYPES[kind]}`
    })
    .join('\n')
  return `export interface ${catalogue.typeName} {\n${fields}\n}`
}

const banner =
  '// Generated by scripts/generate-docs-catalogue.ts -- do not edit by hand.\n' +
  '// The rows come from app/content/docs/_data/, which the release freeze pins\n' +
  '// to the released tag. Edit the data there, never this file.\n\n' +
  "import { type DocsChannelName } from '@/lib/docs-channel'\n"

await rm(OUT_DIR, { recursive: true, force: true })
await mkdir(OUT_DIR, { recursive: true })

for (const catalogue of CATALOGUES) {
  const byChannel = Object.fromEntries(
    CHANNELS.map((channel) => [channel, resolved[channel][catalogue.module]]),
  )
  await writeFile(
    join(OUT_DIR, `docs-${catalogue.module}.ts`),
    `${banner}
${rowInterface(catalogue)}

export const ${catalogue.module}ByChannel: Record<DocsChannelName, ${catalogue.typeName}[]> =
  ${JSON.stringify(byChannel, null, 2).replace(/\n/g, '\n  ')}
`,
    'utf8',
  )
}

const pagesByChannel = Object.fromEntries(
  CHANNELS.map((channel) => [channel, [...pages[channel].routes].sort()]),
)

await writeFile(
  join(OUT_DIR, 'docs-pages.ts'),
  `${banner}
/** Channel -> the channel-relative routes that have a page. */
export const pagesByChannel: Record<DocsChannelName, string[]> =
  ${JSON.stringify(pagesByChannel, null, 2).replace(/\n/g, '\n  ')}
`,
  'utf8',
)

const anchorsByChannel = Object.fromEntries(
  CHANNELS.map((channel) => [channel, pages[channel].anchors]),
)

await writeFile(
  join(OUT_DIR, 'docs-anchors.ts'),
  `${banner}
/** Channel -> route -> normalised heading text -> the anchor id MDX renders. */
export const anchorsByChannel: Record<
  DocsChannelName,
  Record<string, Record<string, string>>
> =
  ${JSON.stringify(anchorsByChannel, null, 2).replace(/\n/g, '\n  ')}
`,
  'utf8',
)

const counts = CHANNELS.map(
  (channel) =>
    `${channel}: ${CATALOGUES.reduce(
      (n, c) => n + resolved[channel][c.module].length,
      0,
    )} row(s) across ${pages[channel].routes.size} page(s)`,
).join(', ')

console.log(`Generated the docs catalogues (${counts}).`)
if (fellBack.length > 0) {
  console.log(
    `  Fell back to the repository data for: ${fellBack.join(', ')} ` +
      `(that channel predates app/content/docs/_data).`,
  )
}
