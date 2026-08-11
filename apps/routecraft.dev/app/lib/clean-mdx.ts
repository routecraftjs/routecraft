/**
 * Turns MDX content source into plain markdown: no components, no JSX, no
 * imports.
 *
 * The raw mirrors under `public/raw/**` are a product surface, not a build
 * artefact: they are what an LLM crawl, a "copy page" click, or a cross-post
 * reads. Anything the site renders through a component has to be re-stated in
 * words here, because a reader of the raw file has nothing else to go on.
 *
 * The conversion is textual, like `scripts/convert-markdoc.ts`, and for the
 * same reason: prose, links and fenced code are already plain markdown, so
 * rewriting only the component constructs leaves every other byte untouched and
 * keeps the diff against the captured production baseline meaningful. It also
 * avoids a remark pipeline, which cannot be loaded under bun's isolated linker
 * (`unist-util-visit-parents` self-references through its own `exports` map).
 *
 * Fenced code and inline code are never rewritten: content documents this very
 * framework, so `<T>` generics and JSX samples are ordinary payload.
 *
 * A surviving component name is fatal. Silently shipping `<Callout ...>` into a
 * mirror is exactly the defect this module exists to prevent.
 */

import { FIGURE_TEXT, figureImagePath } from '@/components/figures/manifest.mjs'

/**
 * Production origin for the absolute URLs in cleaned markdown. Raw markdown is
 * read away from the site (an LLM crawl, a dev.to cross-post, a pasted page),
 * where a root-relative URL resolves against the wrong host or nothing at all.
 * Mirrors the fallback in `lib/site.ts`.
 */
const SITE_ORIGIN = 'https://routecraft.dev'

/**
 * The five reference indexes render a catalogue from `docs/_data/*.json` at
 * request time, so there is no markup behind them to unwrap. Naming the
 * catalogue and linking to the page it renders on is the honest plain-markdown
 * stand-in; the alternative, which production shipped, was leaking the tag
 * itself into the mirror.
 */
interface ReferenceIndex {
  /** Link text: what the catalogue is. */
  name: string
  /** What a reader loses by not seeing the rendered table. */
  contents: string
  /** Channel-relative route of the page the catalogue renders on. */
  route: string
}

const REFERENCE_INDEXES: Record<string, ReferenceIndex> = {
  OperationsIndex: {
    name: 'Operations catalogue',
    contents: 'every operation with its category, signature and summary',
    route: '/docs/reference/operations',
  },
  AdapterGrid: {
    name: 'Adapter catalogue',
    contents: 'every adapter with its category and the roles it can play',
    route: '/docs/reference/adapters',
  },
  PluginIndex: {
    name: 'Plugin catalogue',
    contents: 'every plugin with its config key and what it provides',
    route: '/docs/reference/plugins',
  },
  ErrorTable: {
    name: 'Error code table',
    contents: 'every error code with its meaning and retry behaviour',
    route: '/docs/reference/errors',
  },
  EventNamespaces: {
    name: 'Event namespace map',
    contents: 'every event namespace with the events it emits',
    route: '/docs/reference/events',
  },
}

/**
 * The trigger topology is an animated schematic with no exported still, so it
 * has no image to fall back to the way a `<Diagram>` does. Its point survives
 * as one sentence.
 */
const TOPOLOGY_DIAGRAM_TEXT =
  '_Trigger topology: any source (`cron`, `mcp`, `http`, `mail`, `file`, `timer`) ' +
  'feeds one capability, which reaches any destination (`file`, `log`, `mail`, ' +
  '`direct`, `agent`, `http`)._'

/** Wrapper tags that carry no text of their own and simply disappear. */
const UNWRAPPED = new Set([
  '<Lead>',
  '</Lead>',
  '<CodeTabs>',
  '</CodeTabs>',
  '</CodeTab>',
  '<QuickLinks>',
  '</QuickLinks>',
])

/**
 * Component names that must not reach a mirror. `Diagram` is absent on
 * purpose: an unknown figure id is left as-is rather than turned into an image
 * link that 404s.
 */
const AUDITED_COMPONENTS = [
  'Lead',
  'QuickLinks',
  'QuickLink',
  'CodeTabs',
  'CodeTab',
  'Callout',
  'Badge',
  'TopologyDiagram',
  ...Object.keys(REFERENCE_INDEXES),
]

const FENCE = /^\s*(```+|~~~+)/

/** MDX's ESM block. Content carries none today; the contract forbids one. */
const ESM_STATEMENT =
  /^(?:import\s+[^'"]*\s+from\s+['"][^'"]+['"];?|import\s+['"][^'"]+['"];?|export\s+(?:default|const|let|var|function|class|\*|\{).*)$/

/** Marks which lines sit inside a fenced code block. */
function fenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = []
  let fence: string | null = null

  for (const line of lines) {
    const match = FENCE.exec(line)
    if (match) {
      if (fence === null) fence = match[1]
      else if (match[1].startsWith(fence)) fence = null
      mask.push(true)
      continue
    }
    mask.push(fence !== null)
  }

  return mask
}

/**
 * Reads a JSX attribute list into a record of string values.
 *
 * Attribute order is not fixed by the converter, and a value containing a
 * double quote arrives as a `{"..."}` expression, so scanning beats a
 * positional regex per component.
 */
function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern =
    /([a-zA-Z][\w-]*)(?:=(?:"([^"]*)"|'([^']*)'|\{("(?:[^"\\]|\\.)*")\}))?/g

  for (const match of source.matchAll(pattern)) {
    const [, name, doubleQuoted, singleQuoted, expression] = match
    if (expression !== undefined) {
      attributes[name] = JSON.parse(expression) as string
    } else {
      attributes[name] = doubleQuoted ?? singleQuoted ?? 'true'
    }
  }

  return attributes
}

/** The bolded first line of a callout blockquote. */
function calloutLabel(type: string, title: string | undefined): string {
  const heading = type.charAt(0).toUpperCase() + type.slice(1)
  return title ? `**${heading}: ${title}**` : `**${heading}**`
}

/** Index of the first line at or after `from` that is not blank. */
function skipBlank(lines: string[], from: number): number {
  let index = from
  while (index < lines.length && lines[index].trim() === '') index += 1
  return index
}

/** Rewrites the inline constructs on one line, leaving code spans untouched. */
function cleanInline(line: string): string {
  return line
    .split(/(``[^`]*``|`[^`]*`)/)
    .map((segment, position) =>
      position % 2 === 1
        ? segment
        : segment
            .replace(/<Badge\b[^>]*>([\s\S]*?)<\/Badge>/g, '[$1]')
            // A heading id is authoring metadata that MDX escapes so it is not
            // read as an expression. It is never content.
            .replace(/\s*\\\{#[\w-]+\}/g, ''),
    )
    .join('')
}

/**
 * Strips MDX component syntax from content source and returns clean, standard
 * markdown suitable for copying or serving as a raw file.
 *
 * @param source Raw MDX content, frontmatter included
 * @param title  Optional title to prepend as an H1 heading
 */
export function cleanMdx(source: string, title?: string): string {
  // A cross-post declares its original publication in frontmatter. The raw
  // markdown is exactly the surface that gets scraped and republished, so the
  // attribution must survive the frontmatter strip below; it is re-emitted
  // under the title at the end.
  const canonical = source.match(
    /^---[\s\S]*?^canonical:\s*(https?:\S+)\s*$[\s\S]*?---/m,
  )?.[1]

  const body = source.replace(/^---[\s\S]*?---\n*/, '')
  const lines = body.split('\n')
  const fenced = fenceMask(lines)
  const out: string[] = []

  let index = 0
  while (index < lines.length) {
    const line = lines[index]

    if (fenced[index]) {
      out.push(line)
      index += 1
      continue
    }

    const trimmed = line.trim()

    if (UNWRAPPED.has(trimmed) || ESM_STATEMENT.test(trimmed)) {
      index += 1
      continue
    }

    // A code tab's label sits directly on top of its fence, as the Markdoc tag
    // it replaces did; the blank line between them is MDX block syntax.
    const codeTab = /^<CodeTab\b([^>]*)>$/.exec(trimmed)
    if (codeTab) {
      const { label } = parseAttributes(codeTab[1])
      if (!label) {
        throw new Error(`<CodeTab> without a label at line ${index + 1}`)
      }
      out.push(`**${label}:**`)
      index = skipBlank(lines, index + 1)
      continue
    }

    const quickLink = /^<QuickLink\b([^>]*)\/>$/.exec(trimmed)
    if (quickLink) {
      const {
        title: linkTitle,
        href,
        description,
      } = parseAttributes(quickLink[1])
      if (!linkTitle || !href) {
        throw new Error(
          `<QuickLink> without a title or href at line ${index + 1}`,
        )
      }
      out.push(
        description
          ? `- [${linkTitle}](${href}) -- ${description}`
          : `- [${linkTitle}](${href})`,
      )
      index += 1
      // Quick links are one list, so the blank line MDX needs between two of
      // them would otherwise split it into two.
      const following = skipBlank(lines, index)
      if (/^<QuickLink\b/.test(lines[following]?.trim() ?? ''))
        index = following
      continue
    }

    const callout = /^<Callout\b([^>]*)>$/.exec(trimmed)
    if (callout) {
      const { type = 'note', title: calloutTitle } = parseAttributes(callout[1])
      let end = index + 1
      while (end < lines.length && lines[end].trim() !== '</Callout>') end += 1
      if (end === lines.length) {
        throw new Error(`unterminated <Callout> at line ${index + 1}`)
      }

      const content = lines.slice(index + 1, end)
      while (content.length > 0 && content[0].trim() === '') content.shift()
      while (content.length > 0 && content[content.length - 1].trim() === '') {
        content.pop()
      }

      out.push(
        `> ${calloutLabel(type, calloutTitle)}`,
        '>',
        ...content.map((entry) => `> ${cleanInline(entry)}`),
      )
      index = end + 1
      continue
    }

    // A figure is a React drawing that only exists on the site, so outside it
    // the component is noise; the light PNG and the figure's own words are what
    // a reader or a crawler can use. Italic caption underneath, as a plain
    // reader has no figcaption.
    const diagram = /^<Diagram\b([^>]*)\/>$/.exec(trimmed)
    if (diagram) {
      const id = parseAttributes(diagram[1]).id
      const text = FIGURE_TEXT[id]
      // An unknown id means a typo or a renamed figure. Leave the component
      // alone rather than emit an image link that 404s.
      if (!text) {
        out.push(line)
        index += 1
        continue
      }
      out.push(
        `![${text.alt}](${SITE_ORIGIN}${figureImagePath(id)})`,
        '',
        `_${text.caption}_`,
      )
      index += 1
      continue
    }

    if (/^<TopologyDiagram\b[^>]*\/>$/.test(trimmed)) {
      out.push(TOPOLOGY_DIAGRAM_TEXT)
      index += 1
      continue
    }

    const selfClosing = /^<([A-Z][A-Za-z]*)\b[^>]*\/>$/.exec(trimmed)
    const catalogue = selfClosing
      ? REFERENCE_INDEXES[selfClosing[1]]
      : undefined
    if (catalogue) {
      out.push(
        `_[${catalogue.name}](${SITE_ORIGIN}${catalogue.route}): ` +
          `${catalogue.contents}, generated on the site._`,
      )
      index += 1
      continue
    }

    out.push(cleanInline(line))
    index += 1
  }

  let cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n')

  cleaned = title ? `# ${title}\n\n${cleaned.trim()}\n` : `${cleaned.trim()}\n`

  // Attribution line for cross-posts, directly under the title so a reader (or
  // an LLM) of the raw file sees where the article's home is.
  if (canonical) {
    cleaned = cleaned.replace(
      /\n\n/,
      `\n\n_Originally published at ${canonical}_\n\n`,
    )
  }

  audit(cleaned)

  return cleaned
}

/** Fails the build on any component that reached the output. */
function audit(cleaned: string): void {
  const lines = cleaned.split('\n')
  const fenced = fenceMask(lines)
  const survivor = new RegExp(
    `</?(?:${AUDITED_COMPONENTS.join('|')})(?=[\\s/>])`,
  )

  for (const [position, line] of lines.entries()) {
    if (fenced[position]) continue
    const bare = line.replace(/``[^`]*``|`[^`]*`/g, '')
    if (survivor.test(bare)) {
      throw new Error(
        `component syntax survived cleaning at line ${position + 1}: ${line.trim()}`,
      )
    }
  }
}
