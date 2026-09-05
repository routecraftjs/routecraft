import { describe, expect, test } from 'bun:test'

import { cleanMdx } from './clean-mdx.ts'

describe('cleanMdx: example-gate marker stripping', () => {
  /**
   * @case A real marked fence has its marker stripped from the raw mirror
   * @preconditions A single ts fence carrying a skip marker as fence meta
   * @expectedResult The marker is gone from the opening delimiter; the code is untouched
   */
  test('a genuine marker is stripped', () => {
    const source = [
      '```ts skip="fragment: dest is illustrative"',
      '.enrich(dest, none())',
      '```',
      '',
    ].join('\n')

    expect(cleanMdx(source)).toBe(
      ['```ts', '.enrich(dest, none())', '```', ''].join('\n'),
    )
  })

  /**
   * @case A marker shown as literal text inside a wider fence is left alone
   * @preconditions Two illustrative ```ts marker lines nested inside an outer ```` fence, the
   *   shape the contribution guide uses to document the marker syntax itself
   * @expectedResult Both inner lines survive verbatim, because they are content being shown
   *   to the reader, not a real fence this gate would compile
   */
  test('a marker nested inside a wider fence is not stripped', () => {
    const source = [
      '````',
      '```ts skip="fragment: dest is illustrative"',
      '```ts expect-error="json() takes path, not file"',
      '````',
      '',
    ].join('\n')

    expect(cleanMdx(source)).toBe(source)
  })

  /**
   * @case Two real marked fences with no blank line between them both get stripped
   * @preconditions A closing delimiter immediately followed by another opening delimiter
   * @expectedResult Both markers are stripped, proving the fix does not depend on a blank
   *   line separating adjacent fences
   */
  test('adjacent fences with no gap both have their markers stripped', () => {
    const source = [
      '```ts skip="a"',
      'x',
      '```',
      '```ts skip="b"',
      'y',
      '```',
      '',
    ].join('\n')

    expect(cleanMdx(source)).toBe(
      ['```ts', 'x', '```', '```ts', 'y', '```', ''].join('\n'),
    )
  })
})
