import { describe, expect, test } from 'bun:test'

import {
  extractCheatCode,
  extractFences,
  isTypeScript,
  MarkerError,
  parseMarker,
} from './extract.ts'

const FILE = '/docs/example/index.mdx'

describe('parseMarker', () => {
  /**
   * @case A fence with no meta is checked
   * @preconditions Empty meta string
   * @expectedResult Marker kind is "check", so an unmarked block must compile
   */
  test('empty meta means the block must compile', () => {
    expect(parseMarker('', FILE, 1)).toEqual({ kind: 'check' })
  })

  /**
   * @case A skip marker carries its reason through
   * @preconditions Meta is `skip="fragment: dest is illustrative"`
   * @expectedResult Marker is a skip carrying the reason verbatim
   */
  test('skip keeps its reason', () => {
    expect(
      parseMarker('skip="fragment: dest is illustrative"', FILE, 1),
    ).toEqual({
      kind: 'skip',
      reason: 'fragment: dest is illustrative',
    })
  })

  /**
   * @case An expect-error marker carries its reason through
   * @preconditions Meta is `expect-error="json() takes path, not file"`
   * @expectedResult Marker is an expect-error carrying the reason verbatim
   */
  test('expect-error keeps its reason', () => {
    expect(
      parseMarker('expect-error="json() takes path, not file"', FILE, 1),
    ).toEqual({
      kind: 'expect-error',
      reason: 'json() takes path, not file',
    })
  })

  /**
   * @case A marker written without a reason is rejected
   * @preconditions Meta is a bare `skip` with no quoted reason
   * @expectedResult MarkerError naming the file and line, so the typo cannot silently disable the check
   */
  test('a bare skip is an error, not a silent exclusion', () => {
    expect(() => parseMarker('skip', FILE, 12)).toThrow(MarkerError)
    expect(() => parseMarker('skip', FILE, 12)).toThrow(/needs a quoted reason/)
  })

  /**
   * @case A marker with an empty reason is rejected
   * @preconditions Meta is `skip=""`
   * @expectedResult MarkerError, because an exclusion with no reason is unreviewable
   */
  test('an empty reason is an error', () => {
    expect(() => parseMarker('skip=""', FILE, 3)).toThrow(/non-empty reason/)
  })

  /**
   * @case An unrecognised marker is rejected rather than ignored
   * @preconditions Meta is `skipp="typo"`, which is not a marker
   * @expectedResult MarkerError, so a misspelled marker fails loudly instead of leaving the block checked and confusing
   */
  test('an unrecognised marker is an error', () => {
    expect(() => parseMarker('skipp="typo"', FILE, 4)).toThrow(
      /unrecognised marker/,
    )
  })
})

describe('extractFences', () => {
  /**
   * @case A plain fence yields its code and the line an author would edit
   * @preconditions One `ts` fence opening on line 3 of the source
   * @expectedResult One block whose fenceLine is 3, codeLine is 4, and code excludes the fence delimiters
   */
  test('a fence reports the line of its opening delimiter', () => {
    const source = ['# Title', '', '```ts', 'const a = 1', '```', ''].join('\n')
    const blocks = extractFences(FILE, source)

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      lang: 'ts',
      fenceLine: 3,
      codeLine: 4,
      code: 'const a = 1',
      marker: { kind: 'check' },
    })
  })

  /**
   * @case A fence indented inside a list item yields unindented code
   * @preconditions Fence opened with two leading spaces, body indented to match
   * @expectedResult Code has the fence's indentation stripped from every line
   */
  test('an indented fence has its indentation stripped', () => {
    const source = [
      '- item',
      '',
      '  ```ts',
      '  const a = 1',
      '  const b = 2',
      '  ```',
    ].join('\n')
    const blocks = extractFences(FILE, source)

    expect(blocks).toHaveLength(1)
    expect(blocks[0].code).toBe('const a = 1\nconst b = 2')
  })

  /**
   * @case A marker on a fence is parsed onto the block
   * @preconditions Fence meta is `skip="fragment"`
   * @expectedResult Block carries the skip marker with its reason
   */
  test('a fence marker reaches the block', () => {
    const source = ['```ts skip="fragment"', '.to(dest)', '```'].join('\n')
    const blocks = extractFences(FILE, source)

    expect(blocks[0].marker).toEqual({ kind: 'skip', reason: 'fragment' })
  })

  /**
   * @case Non-TypeScript fences are extracted but identifiable
   * @preconditions One `bash` fence and one `ts` fence
   * @expectedResult Both are returned; isTypeScript distinguishes them
   */
  test('fences of every language are returned with their language', () => {
    const source = [
      '```bash',
      'bun install',
      '```',
      '',
      '```ts',
      'const a = 1',
      '```',
    ].join('\n')
    const blocks = extractFences(FILE, source)

    expect(blocks.map((b) => b.lang)).toEqual(['bash', 'ts'])
    expect(blocks.filter((b) => isTypeScript(b.lang))).toHaveLength(1)
  })

  /**
   * @case A fence that is never closed still yields its block and does not swallow later ones
   * @preconditions Two ts fences, the second missing its closing delimiter at end of file
   * @expectedResult Both blocks are returned, so coverage cannot silently drop to zero for the rest of a page
   */
  test('an unterminated fence does not swallow the rest of the file', () => {
    const source = [
      '```ts',
      'const a = 1',
      '```',
      '',
      '```ts',
      'const b = 2',
    ].join('\n')
    const blocks = extractFences(FILE, source)

    expect(blocks.map((b) => b.code)).toEqual(['const a = 1', 'const b = 2'])
  })

  /**
   * @case Meta on a language the gate does not compile is left alone
   * @preconditions A json fence carrying `title="craft.config.json"`, ordinary markdown meta
   * @expectedResult Extracted without error, because the gate does not own the meta slot on fences it never compiles
   */
  test('meta on a non-TypeScript fence is not claimed', () => {
    const blocks = extractFences(
      FILE,
      '```json title="craft.config.json"\n{}\n```',
    )

    expect(blocks[0].lang).toBe('json')
    expect(blocks[0].marker).toEqual({ kind: 'check' })
  })

  /**
   * @case A misspelled marker on a TypeScript fence is still rejected
   * @preconditions A ts fence carrying `skipp="typo"`
   * @expectedResult Throws, so relaxing the rule for other languages did not lose the typo protection where it matters
   */
  test('a misspelled marker on a ts fence is still an error', () => {
    expect(() =>
      extractFences(FILE, '```ts skipp="typo"\nconst a = 1\n```'),
    ).toThrow(/unrecognised marker/)
  })

  /**
   * @case Consecutive fences do not bleed into one another
   * @preconditions Two adjacent ts fences separated by a blank line
   * @expectedResult Two blocks, each holding only its own code
   */
  test('adjacent fences stay separate', () => {
    const source = [
      '```ts',
      'const a = 1',
      '```',
      '',
      '```ts',
      'const b = 2',
      '```',
    ].join('\n')
    const blocks = extractFences(FILE, source)

    expect(blocks.map((b) => b.code)).toEqual(['const a = 1', 'const b = 2'])
  })
})

describe('extractCheatCode', () => {
  const TSX = '/cheat-sheet/CheatSheet.tsx'

  /**
   * @case A CheatCode block without a language prop is treated as TypeScript
   * @preconditions `<CheatCode>` with no language attribute, matching the component's own default
   * @expectedResult Block language is "ts", so an unlabelled block is checked rather than skipped
   */
  test('language defaults to ts', () => {
    const source = '<CheatCode>{`const a = 1`}</CheatCode>'
    const blocks = extractCheatCode(TSX, source)

    expect(blocks).toHaveLength(1)
    expect(blocks[0].lang).toBe('ts')
    expect(blocks[0].code).toBe('const a = 1')
  })

  /**
   * @case An explicit language prop is honoured
   * @preconditions `<CheatCode language="bash">`
   * @expectedResult Block language is "bash" and isTypeScript rejects it
   */
  test('an explicit language is read from the prop', () => {
    const blocks = extractCheatCode(
      TSX,
      '<CheatCode language="bash">{`bun install`}</CheatCode>',
    )

    expect(blocks[0].lang).toBe('bash')
    expect(isTypeScript(blocks[0].lang)).toBe(false)
  })

  /**
   * @case Template-literal escaping is undone before the code is compiled
   * @preconditions Source contains an escaped backtick and an escaped interpolation, as the cheat sheet's dynamic-URL example does
   * @expectedResult Code holds a real template literal, not the escape sequences, so it is not read as an unterminated literal
   */
  test('escaped backticks and interpolations are restored', () => {
    const source =
      '<CheatCode>{`.to(http({ url: ex => \\`/\\${ex.body.id}\\` }))`}</CheatCode>'
    const blocks = extractCheatCode(TSX, source)

    expect(blocks[0].code).toBe('.to(http({ url: ex => `/${ex.body.id}` }))')
  })

  /**
   * @case A skip prop on a CheatCode block is read as a marker
   * @preconditions `<CheatCode skip="fragment: chain shown without its source">`
   * @expectedResult Block carries the skip marker with its reason
   */
  test('a skip prop reaches the block', () => {
    const source =
      '<CheatCode skip="fragment: chain shown without its source">{`.to(log())`}</CheatCode>'
    const blocks = extractCheatCode(TSX, source)

    expect(blocks[0].marker).toEqual({
      kind: 'skip',
      reason: 'fragment: chain shown without its source',
    })
  })

  /**
   * @case A block claiming both markers is rejected
   * @preconditions `<CheatCode>` carries skip and expect-error together
   * @expectedResult MarkerError, because the two demand opposite outcomes
   */
  test('skip and expect-error together is an error', () => {
    const source = '<CheatCode skip="a" expect-error="b">{`x`}</CheatCode>'

    expect(() => extractCheatCode(TSX, source)).toThrow(MarkerError)
  })

  /**
   * @case A reason containing a closing angle bracket does not drop the block
   * @preconditions `<CheatCode skip="fragment: () => void">`, a reason quoting an arrow type
   * @expectedResult The block is extracted with its marker, rather than failing the match and vanishing
   */
  test('a marker reason may contain an angle bracket', () => {
    const source =
      '<CheatCode skip="fragment: () => void">{`const a = 1`}</CheatCode>'
    const blocks = extractCheatCode(TSX, source)

    expect(blocks).toHaveLength(1)
    expect(blocks[0].marker).toEqual({
      kind: 'skip',
      reason: 'fragment: () => void',
    })
  })

  /**
   * @case A CheatCode block that is not a template literal fails loudly
   * @preconditions A tag whose children are plain text rather than `{`...`}`
   * @expectedResult Throws, because a block that is silently not extracted reads as covered when it is not
   */
  test('a block the extractor cannot read is an error, not a silent skip', () => {
    expect(() =>
      extractCheatCode(TSX, '<CheatCode>not a template</CheatCode>'),
    ).toThrow(/would be skipped silently/)
  })

  /**
   * @case A tag wrapped across lines still points diagnostics at the code
   * @preconditions The tag spans three lines before the template's opening backtick
   * @expectedResult codeLine is the line the code actually starts on, not the line after the tag
   */
  test('a multi-line tag maps to the line the code starts on', () => {
    const source = [
      '<CheatCode',
      '  skip="a reason"',
      '>{`',
      'const a = 1`}</CheatCode>',
    ].join('\n')
    const blocks = extractCheatCode(TSX, source)

    expect(blocks[0].fenceLine).toBe(1)
    expect(blocks[0].codeLine).toBe(4)
  })

  /**
   * @case Several CheatCode blocks in one file are found and located
   * @preconditions Two blocks separated by a newline
   * @expectedResult Two blocks with ascending fence lines
   */
  test('every CheatCode block in the file is extracted', () => {
    const source = [
      '<CheatCode>{`const a = 1`}</CheatCode>',
      '<CheatCode>{`const b = 2`}</CheatCode>',
    ].join('\n')
    const blocks = extractCheatCode(TSX, source)

    expect(blocks.map((b) => b.code)).toEqual(['const a = 1', 'const b = 2'])
    expect(blocks[0].fenceLine).toBe(1)
    expect(blocks[1].fenceLine).toBe(2)
  })
})
