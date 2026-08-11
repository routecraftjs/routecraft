#!/usr/bin/env node

/**
 * Materialises the per-channel reference catalogues under src/lib/generated/:
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
 * src/app/docs/_data/*.json, inside the tree the release freeze replaces, and
 * generate-docs-next.mjs copies them into the next channel alongside the pages.
 * This script reads whichever copy each channel carries and emits it as a typed
 * module per catalogue (one file each, so a page only bundles its own rows).
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
 * the oldest tag the release workflow will freeze carries src/app/docs/_data.
 *
 * The anchor map is keyed by the normalised heading text (lowercase,
 * alphanumeric only) and resolves to the id Markdoc actually renders, which is
 * `slugifyWithCounter` of the heading (so `## RC1001` is `rc-1001`, not
 * `rc1001`). Callers therefore never hand-build an anchor.
 *
 * The output is gitignored and rebuilt on each prebuild. Run after
 * generate-docs-next.mjs so the next channel is part of the walk, and after the
 * release freeze so the latest channel reflects the released tag.
 *
 * Run as: node --experimental-strip-types scripts/generate-docs-catalogue.mjs
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import glob from 'fast-glob'
import { slugifyWithCounter } from '@sindresorhus/slugify'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DOCS_DIR = path.join(ROOT, 'src', 'app', 'docs')
const DATA_DIR = path.join(DOCS_DIR, '_data')
const OUT_DIR = path.join(ROOT, 'src', 'lib', 'generated')

const CHANNELS = ['latest', 'next']

/**
 * One catalogue per data file. `page` names the reference folder each row must
 * have a page in; `anchorsIn` names the page each row must have a heading on.
 * Exactly one of the two applies: a row either owns a page or is a section of
 * a shared page.
 */
const CATALOGUES = [
  {
    file: 'operations.json',
    module: 'operations',
    typeName: 'OperationRow',
    key: (row) => row.name,
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
    key: (row) => row.name,
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
    key: (row) => row.name,
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
    key: (row) => row.code,
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
    key: (row) => row.anchor,
    anchorsIn: 'reference/events',
    fields: {
      pattern: 'string',
      events: 'string[]',
      anchor: 'string',
      note: 'string?',
    },
  },
]

/** Lookup key for an anchor: comparable across `RC1001`, `rc-1001`, `RC 1001`. */
function normaliseHeading(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Slug for a row that owns a page, matching src/lib/slug.ts. */
function rowSlug(value) {
  return value.toLowerCase().replace(/\s+/g, '-')
}

/**
 * Heading ids for a page, as Markdoc renders them (see src/markdoc/nodes.js:
 * one `slugifyWithCounter` per document, applied to the heading text). Markdoc
 * tags and inline emphasis are stripped first because they are not part of the
 * rendered text either.
 */
function pageAnchors(markdown) {
  const slugify = slugifyWithCounter()
  const anchors = {}
  let inFence = false

  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const heading = line.match(/^#{2,6}\s+(.+?)\s*$/)
    if (!heading) continue

    const text = heading[1]
      .replace(/\{%[^%]*%\}/g, '')
      .replace(/[`*_]/g, '')
      .trim()
    if (!text) continue

    anchors[normaliseHeading(text)] = slugify(text)
  }

  return anchors
}

/** Split a `**\/page.md` path into its channel and its channel-relative route. */
function locate(file) {
  const route = path.dirname(file).split(path.sep).join('/')
  if (route === 'next' || route.startsWith('next/')) {
    return {
      channel: 'next',
      route: route.slice('next'.length).replace(/^\//, ''),
    }
  }
  return { channel: 'latest', route }
}

// --- Walk the pages of every channel -----------------------------------------

const pages = Object.fromEntries(
  CHANNELS.map((channel) => [channel, { routes: new Set(), anchors: {} }]),
)

const anchorRoutes = CATALOGUES.map((c) => c.anchorsIn).filter(Boolean)

for (const file of glob.sync('**/page.md', { cwd: DOCS_DIR })) {
  const { channel, route } = locate(file)
  pages[channel].routes.add(route)
  if (anchorRoutes.includes(route)) {
    pages[channel].anchors[route] = pageAnchors(
      fs.readFileSync(path.join(DOCS_DIR, file), 'utf8'),
    )
  }
}

// --- Resolve each channel's rows ---------------------------------------------

/** The `_data` directory a channel carries, or null when it predates them. */
function dataDir(channel) {
  const dir =
    channel === 'next' ? path.join(DOCS_DIR, 'next', '_data') : DATA_DIR
  return fs.existsSync(dir) ? dir : null
}

function readRows(dir, catalogue) {
  const file = path.join(dir, catalogue.file)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** Whether a channel documents a row: its own page, or a heading on a shared one. */
function documents(channel, catalogue, row) {
  if (catalogue.page) {
    return pages[channel].routes.has(
      `${catalogue.page}/${rowSlug(catalogue.key(row))}`,
    )
  }
  const anchors = pages[channel].anchors[catalogue.anchorsIn] ?? {}
  return Boolean(anchors[normaliseHeading(catalogue.key(row))])
}

/** See "THE FALLBACK" above: prune the repository's rows to what shipped. */
function fallbackRows(channel, catalogue) {
  const rows = readRows(DATA_DIR, catalogue) ?? []
  return rows.filter((row) => documents(channel, catalogue, row))
}

function validate(channel, catalogue, rows) {
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

const resolved = Object.fromEntries(CHANNELS.map((channel) => [channel, {}]))
const fellBack = []

for (const channel of CHANNELS) {
  const dir = dataDir(channel)
  for (const catalogue of CATALOGUES) {
    const own = dir ? readRows(dir, catalogue) : null
    if (own) {
      validate(channel, catalogue, own)
      resolved[channel][catalogue.module] = own
    } else {
      resolved[channel][catalogue.module] = fallbackRows(channel, catalogue)
      fellBack.push(`${channel}/${catalogue.module}`)
    }
  }
}

// --- Emit ---------------------------------------------------------------------

const FIELD_TYPES = {
  string: 'string',
  'string?': 'string | undefined',
  boolean: 'boolean',
  'boolean?': 'boolean | undefined',
  'string[]': 'string[]',
}

function rowInterface(catalogue) {
  const fields = Object.entries(catalogue.fields)
    .map(([name, kind]) => {
      const optional = kind.endsWith('?')
      return `  ${name}${optional ? '?' : ''}: ${FIELD_TYPES[kind]}`
    })
    .join('\n')
  return `export interface ${catalogue.typeName} {\n${fields}\n}`
}

const banner =
  '// Generated by scripts/generate-docs-catalogue.mjs -- do not edit by hand.\n' +
  '// The rows come from src/app/docs/_data/, which the release freeze pins to\n' +
  '// the released tag. Edit the data there, never this file.\n'

fs.rmSync(OUT_DIR, { recursive: true, force: true })
fs.mkdirSync(OUT_DIR, { recursive: true })

for (const catalogue of CATALOGUES) {
  const byChannel = Object.fromEntries(
    CHANNELS.map((channel) => [channel, resolved[channel][catalogue.module]]),
  )
  fs.writeFileSync(
    path.join(OUT_DIR, `docs-${catalogue.module}.ts`),
    `${banner}
${rowInterface(catalogue)}

export const ${catalogue.module}ByChannel: Record<string, ${catalogue.typeName}[]> =
  ${JSON.stringify(byChannel, null, 2).replace(/\n/g, '\n  ')}
`,
    'utf8',
  )
}

const anchorsByChannel = Object.fromEntries(
  CHANNELS.map((channel) => [channel, pages[channel].anchors]),
)

fs.writeFileSync(
  path.join(OUT_DIR, 'docs-anchors.ts'),
  `${banner}
/** Channel -> route -> normalised heading text -> the anchor id Markdoc renders. */
export const anchorsByChannel: Record<
  string,
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
      `(that channel predates src/app/docs/_data).`,
  )
}
