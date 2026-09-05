/**
 * Pulls the TypeScript examples out of the documentation so they can be
 * compiled.
 *
 * Two sources carry examples, and neither is TypeScript the compiler can see:
 * MDX pages hold them in fenced code blocks, and the cheat sheet holds them in
 * `<CheatCode>` template literals. Both are reduced here to the same
 * {@link ExampleBlock}, carrying enough provenance that a diagnostic can be
 * reported against the line an author actually edits.
 *
 * A block declares that it is not meant to compile with a marker, written as
 * fence meta in MDX and as a prop on `<CheatCode>`. Fence meta is dropped by
 * `@mdx-js/mdx` before rendering, so a marker never reaches the page. An
 * unrecognised or reasonless marker is an error rather than a block that
 * quietly stops being checked: a typo that silently disables a check is worse
 * than no check, because it reads as covered.
 */

import { createProcessor } from '@mdx-js/mdx'
import remarkFrontmatter from 'remark-frontmatter'
import { visit } from 'unist-util-visit'

import type { Code as MdastCode } from 'mdast'

/**
 * The MDX processor, built once.
 *
 * Constructing one per file dominates the parse cost across 130-odd pages.
 */
let cached: ReturnType<typeof createProcessor> | undefined
function processor(): ReturnType<typeof createProcessor> {
  cached ??= createProcessor({ remarkPlugins: [remarkFrontmatter] })
  return cached
}

/** What the gate must do with a block. */
export type BlockMarker =
  | { kind: 'check' }
  | { kind: 'skip'; reason: string }
  | { kind: 'expect-error'; reason: string }

export interface ExampleBlock {
  /** Absolute path of the file the block was written in. */
  file: string
  /** 1-based line of the opening fence, or of the `<CheatCode>` tag. */
  fenceLine: number
  /** 1-based line of the block's first line of code. */
  codeLine: number
  /** The fence's language, or the `<CheatCode>` `language` prop. */
  lang: string
  /**
   * Columns stripped from every line of an indented fence, added back when a
   * diagnostic's column is reported so it points at the character the author
   * sees.
   */
  indent: number
  marker: BlockMarker
  code: string
}

/** Raised when a marker cannot be parsed. Carries the source location. */
export class MarkerError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    message: string,
  ) {
    super(message)
    this.name = 'MarkerError'
  }
}

const TS_LANGUAGES = new Set(['ts', 'typescript', 'tsx'])

/** Whether a fence language names TypeScript the gate should compile. */
export function isTypeScript(lang: string): boolean {
  return TS_LANGUAGES.has(lang)
}

/**
 * Parses a fence's meta string, or a `<CheatCode>` attribute list, into a
 * marker.
 *
 * Accepts `skip="reason"` and `expect-error="reason"`. Both demand a reason,
 * because a marker without one records that a block is excluded while losing
 * the only thing that makes the exclusion reviewable.
 */
export function parseMarker(
  meta: string,
  file: string,
  line: number,
): BlockMarker {
  const trimmed = meta.trim()
  if (trimmed === '') return { kind: 'check' }

  const match = /^(skip|expect-error)="([^"]*)"$/.exec(trimmed)
  if (!match) {
    const bare = /^(skip|expect-error)\b/.exec(trimmed)
    if (bare) {
      throw new MarkerError(
        file,
        line,
        `\`${bare[1]}\` needs a quoted reason, as \`${bare[1]}="why this block cannot compile"\`.`,
      )
    }
    throw new MarkerError(
      file,
      line,
      `unrecognised marker \`${trimmed}\`. Use \`skip="reason"\` or \`expect-error="reason"\`.`,
    )
  }

  const [, kind, reason] = match
  if (reason.trim() === '') {
    throw new MarkerError(file, line, `\`${kind}\` needs a non-empty reason.`)
  }
  return kind === 'skip'
    ? { kind: 'skip', reason }
    : { kind: 'expect-error', reason }
}

/**
 * Extracts fenced code blocks from MDX source.
 *
 * The parse is done by the same MDX processor the site renders with, rather
 * than by a scanner of our own. A scanner has to agree with the renderer about
 * what a fence is, and a disagreement is silent in the direction that matters:
 * a `~~~ts` block, or one opened with four backticks to show a nested fence,
 * renders as code on the site and would simply not be seen here, so the example
 * stops being checked without anything saying so.
 *
 * `remark-frontmatter` is needed so a page's `---` block is not read as a
 * thematic break.
 */
export function extractFences(file: string, source: string): ExampleBlock[] {
  const blocks: ExampleBlock[] = []

  visit(processor().parse(source), 'code', (node: MdastCode) => {
    const position = node.position
    if (!position) return

    const fenceLine = position.start.line
    blocks.push({
      file,
      fenceLine,
      codeLine: fenceLine + 1,
      lang: node.lang ?? '',
      // mdast columns are 1-based, so an unindented fence reports column 1.
      indent: position.start.column - 1,
      // Only the languages this gate compiles own the fence's meta slot.
      // Meta is ordinary markdown, and a `json title="craft.config.json"`
      // fence is not this tool's business; claiming it would fail the build
      // with advice about `skip` that makes no sense for a JSON block.
      marker: isTypeScript(node.lang ?? '')
        ? parseMarker(node.meta ?? '', file, fenceLine)
        : { kind: 'check' },
      code: node.value,
    })
  })

  return blocks
}

/**
 * Undoes the escaping a template literal imposes on its contents.
 *
 * The cheat sheet writes examples inside `` {`...`} ``, so a backtick or a
 * `${` in the example is escaped in the source and must be restored before the
 * code is compiled. Missing this turns a valid example into an unterminated
 * template literal, which reads as a defect in the docs rather than in the
 * extractor.
 */
function unescapeTemplate(raw: string): string {
  return raw.replace(/\\(`|\$|\\)/g, '$1')
}

/**
 * Reads one attribute's value out of a `<CheatCode>` attribute list,
 * accepting either quote style.
 *
 * Attributes are tokenised and compared by captured name rather than
 * searched for as raw text, so another attribute's value cannot be mistaken
 * for the one being looked up just because it contains matching text (a
 * `note="the marker skip='...' shown as text"` attribute, say).
 */
function attrValue(attrs: string, name: string): string | undefined {
  for (const found of attrs.matchAll(
    /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    if (found[1] === name) return found[2] ?? found[3]
  }
  return undefined
}

/**
 * Extracts `<CheatCode>` blocks from the cheat sheet component.
 *
 * `language` defaults to `ts`, matching the component's own default, so an
 * unlabelled block is checked rather than skipped.
 */
export function extractCheatCode(file: string, source: string): ExampleBlock[] {
  const blocks: ExampleBlock[] = []
  // Matching a real attribute list rather than "anything but >" keeps a
  // reason containing `>` (an arrow function, a generic) from failing the
  // match and dropping the block without a word. Both quote styles and
  // whitespace around `=` are accepted so a valid CheatCode tag never aborts
  // the whole run just because it wasn't formatted the way the rest are.
  const tag =
    /<CheatCode((?:\s+[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*>\{`([\s\S]*?)`\}<\/CheatCode>/g

  let match: RegExpExecArray | null
  while ((match = tag.exec(source))) {
    const [, attrs, raw] = match
    const fenceLine = source.slice(0, match.index).split('\n').length
    // The tag can wrap across lines, so the code does not necessarily start on
    // the line after it. Anchor on the template's own opening backtick,
    // searching only after the attribute list so an attribute value that
    // happens to contain `>{`` can't be mistaken for the real delimiter.
    const afterAttrs = match.index + '<CheatCode'.length + attrs.length
    const literalStart =
      afterAttrs + source.slice(afterAttrs).indexOf('>{`') + 3
    const literalLine = source.slice(0, literalStart).split('\n').length
    const language = attrValue(attrs, 'language') ?? 'ts'

    // Only the languages this gate compiles own the marker attributes, the
    // same rule extractFences applies to fence meta. Without it, a malformed
    // marker on a block the gate was never going to check (a bash or json
    // CheatCode) throws and aborts the whole run, over a block that did not
    // matter in the first place.
    let marker: BlockMarker = { kind: 'check' }
    if (isTypeScript(language)) {
      // Every attribute is checked, not just the two marker names: a typo
      // such as `skipp="..."` would otherwise match neither regex below and
      // be silently read as no marker at all, which is the exact failure the
      // fence path's `parseMarker` already refuses to allow.
      const KNOWN_ATTRIBUTES = new Set([
        'language',
        'className',
        'skip',
        'expect-error',
      ])
      for (const found of attrs.matchAll(
        /([\w-]+)\s*=\s*(?:"[^"]*"|'[^']*')/g,
      )) {
        if (!KNOWN_ATTRIBUTES.has(found[1])) {
          throw new MarkerError(
            file,
            fenceLine,
            `unrecognised CheatCode attribute \`${found[1]}\`. Use \`skip="reason"\` or \`expect-error="reason"\`.`,
          )
        }
      }

      const skip = attrValue(attrs, 'skip')
      const expectError = attrValue(attrs, 'expect-error')
      if (skip !== undefined && expectError !== undefined) {
        throw new MarkerError(
          file,
          fenceLine,
          'a block carries both `skip` and `expect-error`; it can only be one.',
        )
      }
      // Built directly from the parsed value rather than reassembled into a
      // `skip="..."` string and reparsed: a single-quoted reason containing a
      // literal `"` would otherwise come out the other side as unparseable.
      if (skip !== undefined) {
        if (skip.trim() === '') {
          throw new MarkerError(
            file,
            fenceLine,
            '`skip` needs a non-empty reason.',
          )
        }
        marker = { kind: 'skip', reason: skip }
      } else if (expectError !== undefined) {
        if (expectError.trim() === '') {
          throw new MarkerError(
            file,
            fenceLine,
            '`expect-error` needs a non-empty reason.',
          )
        }
        marker = { kind: 'expect-error', reason: expectError }
      }
    }

    // The literal opens on the tag's line, so its first line of code is the next.
    const leading = /^\n*/.exec(raw)?.[0].length ?? 0
    blocks.push({
      file,
      fenceLine,
      codeLine: literalLine + leading,
      lang: language,
      indent: 0,
      marker,
      code: unescapeTemplate(raw.replace(/^\n+|\n+$/g, '')),
    })
  }

  // A tag that does not match the shape above would otherwise vanish without
  // a word, and a block that is silently not extracted reads as covered.
  const tags = (source.match(/<CheatCode\b/g) ?? []).length
  if (blocks.length !== tags) {
    throw new MarkerError(
      file,
      1,
      `found ${tags} <CheatCode> tags but extracted ${blocks.length}. ` +
        'A block is not in the expected `{`...`}` shape and would be skipped silently.',
    )
  }

  return blocks
}
