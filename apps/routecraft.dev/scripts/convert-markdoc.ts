/**
 * Converts Markdoc `page.md` content to MDX.
 *
 * Used three times over the life of the migration:
 *
 * 1. Once to convert the committed content tree.
 * 2. On every release deploy whose freeze tag predates the migration, to turn
 *    that tag's Markdoc content into the MDX tree the site builds from. Delete
 *    that path, and this script, once the oldest freezable tag ships MDX.
 * 3. To re-sync docs authored on main while the migration branch is open,
 *    which is a re-conversion rather than a rebase.
 *
 * The conversion is textual on purpose. Prose, code fences and link syntax are
 * already valid MDX, so only the `{% ... %}` constructs are rewritten and every
 * other byte survives untouched. That keeps the raw-mirror diff meaningful and
 * the change reviewable. Markdoc's own parser then audits the result: the tags
 * it finds must match the components this script emitted, one for one.
 *
 * Anything unrecognised is fatal. A tag with no mapping, an attribute value
 * that cannot be printed as a JSX prop, or leftover Markdoc syntax aborts the
 * run rather than producing best-effort output.
 *
 * Usage:
 *   bun scripts/convert-markdoc.ts <source-dir> <target-dir> [--dry-run]
 *
 * `source-dir` holds `page.md` files at any depth; each is written to
 * `<target-dir>/<same-path>/index.mdx`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { Glob } from 'bun'
import Markdoc from '@markdoc/markdoc'

interface TagMapping {
  /** Component name the tag renders as in MDX. */
  component: string
  /**
   * Block tags are printed on their own line with blank lines around them,
   * which is what makes MDX parse their children as markdown. Inline tags are
   * printed in place so they can sit inside a heading or a list item.
   */
  inline?: boolean
}

/**
 * Every Markdoc tag registered in `src/markdoc/tags.js`, mapped to the MDX
 * component that replaces it. Kebab-case names become PascalCase components.
 *
 * `figure` is unused in content today but kept mapped so content that starts
 * using it converts. The `channel` attribute is deliberately absent: the docs
 * channel now comes from the route rather than from injected markup.
 */
const TAGS: Record<string, TagMapping> = {
  callout: { component: 'Callout' },
  figure: { component: 'Figure' },
  diagram: { component: 'Diagram' },
  'quick-links': { component: 'QuickLinks' },
  'quick-link': { component: 'QuickLink' },
  'code-tabs': { component: 'CodeTabs' },
  'code-tab': { component: 'CodeTab' },
  badge: { component: 'Badge', inline: true },
  'topology-diagram': { component: 'TopologyDiagram' },
  'adapter-grid': { component: 'AdapterGrid' },
  'operations-index': { component: 'OperationsIndex' },
  'plugin-index': { component: 'PluginIndex' },
  'error-table': { component: 'ErrorTable' },
  'event-namespaces': { component: 'EventNamespaces' },
}

class ConversionError extends Error {
  constructor(file: string, line: number, message: string) {
    super(`${file}:${line}: ${message}`)
    this.name = 'ConversionError'
  }
}

const FENCE = /^\s*(```+|~~~+)/

/**
 * Walks lines, reporting which are inside a fenced code block.
 *
 * Content carries no Markdoc syntax inside code samples today, but a page
 * documenting this very migration plausibly would, and silently rewriting a
 * code sample is the kind of corruption that survives review.
 */
function* withFenceState(
  lines: string[],
): Generator<[number, string, boolean]> {
  let fence: string | null = null

  for (const [index, line] of lines.entries()) {
    const match = FENCE.exec(line)
    if (match) {
      const marker = match[1]
      if (fence === null) fence = marker
      else if (marker.startsWith(fence)) fence = null
      yield [index, line, true]
      continue
    }
    yield [index, line, fence !== null]
  }
}

/** Prints a Markdoc attribute list as JSX props. */
function printAttributes(rest: string, file: string, line: number): string {
  const attributes: string[] = []
  let remaining = rest.trim()

  while (remaining.length > 0) {
    const match =
      /^([a-zA-Z][\w-]*)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)\s*/.exec(
        remaining,
      )
    if (!match) {
      throw new ConversionError(
        file,
        line,
        `unrecognised attribute syntax: ${remaining}`,
      )
    }

    const [consumed, name, rawValue] = match
    if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
      const value = rawValue.slice(1, -1)
      attributes.push(
        value.includes('"')
          ? `${name}={${JSON.stringify(value)}}`
          : `${name}="${value}"`,
      )
    } else if (
      rawValue === 'true' ||
      rawValue === 'false' ||
      /^-?\d+(\.\d+)?$/.test(rawValue)
    ) {
      attributes.push(`${name}={${rawValue}}`)
    } else {
      throw new ConversionError(
        file,
        line,
        `cannot print attribute ${name}=${rawValue} as a JSX prop`,
      )
    }

    remaining = remaining.slice(consumed.length)
  }

  return attributes.length > 0 ? ` ${attributes.join(' ')}` : ''
}

interface ConvertedConstruct {
  text: string
  inline: boolean
}

function convertConstruct(
  inner: string,
  file: string,
  line: number,
): ConvertedConstruct {
  // The brace is escaped because MDX would otherwise read `{...}` as a JS
  // expression. It survives as literal text that remarkHeadingId lifts into an
  // id and removes from the rendered heading.
  const headingId = /^#([\w-]+)$/.exec(inner)
  if (headingId) return { text: `\\{#${headingId[1]}}`, inline: true }

  const closing = /^\/([\w-]+)$/.exec(inner)
  if (closing) {
    const mapping = TAGS[closing[1]]
    if (!mapping) {
      throw new ConversionError(file, line, `unknown closing tag ${closing[1]}`)
    }
    return {
      text: `</${mapping.component}>`,
      inline: mapping.inline === true,
    }
  }

  const selfClosing = inner.endsWith('/')
  const body = (selfClosing ? inner.slice(0, -1) : inner).trim()
  const nameMatch = /^([a-zA-Z][\w-]*)/.exec(body)
  if (!nameMatch) {
    throw new ConversionError(
      file,
      line,
      `unrecognised Markdoc construct {% ${inner} %}`,
    )
  }

  const name = nameMatch[1]
  const mapping = TAGS[name]
  if (!mapping) {
    throw new ConversionError(
      file,
      line,
      `unknown tag ${name}; register it in TAGS with its MDX component`,
    )
  }

  const attributes = printAttributes(body.slice(name.length), file, line)
  return {
    text: selfClosing
      ? `<${mapping.component}${attributes} />`
      : `<${mapping.component}${attributes}>`,
    inline: mapping.inline === true,
  }
}

interface ConvertedLine {
  text: string
  /** The line held nothing but block-level constructs. */
  blockOnly: boolean
}

/** Rewrites every construct on one line, leaving inline code untouched. */
function convertLine(
  line: string,
  file: string,
  lineNumber: number,
): ConvertedLine {
  if (!line.includes('{%')) return { text: line, blockOnly: false }

  let output = ''
  let residue = ''
  let inInlineCode = false
  let sawBlock = false
  let index = 0

  while (index < line.length) {
    const character = line[index]

    if (character === '`') {
      inInlineCode = !inInlineCode
      output += character
      residue += character
      index += 1
      continue
    }

    if (!inInlineCode && character === '{' && line[index + 1] === '%') {
      const close = line.indexOf('%}', index + 2)
      if (close === -1) {
        throw new ConversionError(
          file,
          lineNumber,
          'unterminated Markdoc construct',
        )
      }
      const inner = line.slice(index + 2, close).trim()
      const converted = convertConstruct(inner, file, lineNumber)
      output += converted.text
      if (!converted.inline) sawBlock = true
      index = close + 2
      continue
    }

    output += character
    residue += character
    index += 1
  }

  return { text: output, blockOnly: sawBlock && residue.trim() === '' }
}

/**
 * Wraps the paragraph carrying a `{% .lead %}` annotation in `<Lead>`.
 *
 * The annotation is not always on the first paragraph, so styling the first
 * paragraph structurally would mark the wrong one on three pages.
 */
function wrapLeadParagraphs(lines: string[]): string[] {
  const output = [...lines]
  const fenced = new Set<number>()
  for (const [index, , inFence] of withFenceState(lines)) {
    if (inFence) fenced.add(index)
  }

  for (let index = output.length - 1; index >= 0; index -= 1) {
    if (fenced.has(index)) continue
    if (!/\{%\s*\.lead\s*%\}/.test(output[index])) continue

    output[index] = output[index].replace(/\s*\{%\s*\.lead\s*%\}/, '')

    let start = index
    while (start > 0 && output[start - 1].trim() !== '') start -= 1
    let end = index
    while (end < output.length - 1 && output[end + 1].trim() !== '') end += 1

    output.splice(end + 1, 0, '</Lead>')
    output.splice(start, 0, '<Lead>')
  }

  return output
}

export function convert(source: string, file: string): string {
  // Wrapping leads first keeps paragraph boundaries intact, before block tags
  // introduce the blank lines MDX needs.
  const leadWrapped = wrapLeadParagraphs(source.split('\n'))
  const converted: string[] = []

  for (const [index, line, fenced] of withFenceState(leadWrapped)) {
    if (fenced) {
      converted.push(line)
      continue
    }

    const result = convertLine(line, file, index + 1)
    if (result.blockOnly) {
      converted.push('', result.text, '')
    } else {
      converted.push(result.text)
    }
  }

  const normalised = `${converted
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`

  audit(source, normalised, file)

  return normalised
}

/**
 * Confirms the conversion against Markdoc's own parser.
 *
 * Every tag Markdoc finds in the source must appear as its mapped component in
 * the output with the same multiplicity, and no Markdoc syntax may survive.
 */
function audit(source: string, output: string, file: string): void {
  const expected = new Map<string, number>()

  function walk(node: Markdoc.Node): void {
    if (node.type === 'tag' && node.tag) {
      expected.set(node.tag, (expected.get(node.tag) ?? 0) + 1)
    }
    for (const child of node.children ?? []) walk(child)
  }

  walk(Markdoc.parse(source))

  for (const [tag, count] of expected) {
    const mapping = TAGS[tag]
    if (!mapping) {
      throw new ConversionError(
        file,
        0,
        `Markdoc parsed an unmapped tag ${tag}`,
      )
    }
    // The lookahead matters: `<QuickLink` is a prefix of `<QuickLinks`.
    const opening = new RegExp(`<${mapping.component}(?=[\\s/>])`, 'g')
    const found = output.match(opening)?.length ?? 0
    if (found !== count) {
      throw new ConversionError(
        file,
        0,
        `expected ${count} <${mapping.component}> after converting ${tag}, found ${found}`,
      )
    }
  }

  for (const [index, line, fenced] of withFenceState(output.split('\n'))) {
    if (!fenced && line.includes('{%')) {
      throw new ConversionError(
        file,
        index + 1,
        `Markdoc syntax survived conversion: ${line.trim()}`,
      )
    }
  }
}

const [sourceDir, targetDir, ...flags] = process.argv.slice(2)

if (!sourceDir || !targetDir) {
  console.error(
    'Usage: bun scripts/convert-markdoc.ts <source-dir> <target-dir> [--dry-run]',
  )
  process.exit(1)
}

const dryRun = flags.includes('--dry-run')
let converted = 0

for await (const file of new Glob('**/page.md').scan({
  cwd: sourceDir,
  absolute: true,
})) {
  const relativePath = relative(sourceDir, file)
  const output = convert(await readFile(file, 'utf8'), relativePath)
  const target = join(targetDir, relativePath.replace(/page\.md$/, 'index.mdx'))

  if (!dryRun) {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, output)
  }
  converted += 1
}

console.log(
  `${dryRun ? 'Validated' : 'Converted'} ${converted} page(s)${dryRun ? '' : ` into ${targetDir}`}`,
)
