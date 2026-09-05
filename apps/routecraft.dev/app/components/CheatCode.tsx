import { Fragment } from 'react'
import { Highlight } from 'prism-react-renderer'
import clsx from 'clsx'

/**
 * A code block on the cheat sheet.
 *
 * `skip` and `expect-error` are read by the documentation example typecheck
 * (`scripts/check-examples.ts`) and are deliberately not rendered: the marker
 * addresses the build, not the reader. They live on the tag rather than in a
 * comment so a block declares its status in the same place it declares its
 * language.
 */
export function CheatCode({
  children,
  language = 'ts',
  className,
}: {
  children: string
  language?: string
  className?: string
  skip?: string
  'expect-error'?: string
}) {
  const code = children.replace(/^\n+|\n+$/g, '')
  return (
    <Highlight
      code={code}
      language={language}
      theme={{ plain: {}, styles: [] }}
    >
      {({ className: prismClassName, style, tokens, getTokenProps }) => (
        <pre
          className={clsx(
            prismClassName,
            'scrollbar-quiet overflow-x-auto border border-ink/15 bg-paper-deep/40 px-3 py-2.5 text-[0.78rem] leading-relaxed print:bg-white',
            className,
          )}
          style={style}
        >
          <code>
            {tokens.map((line, i) => (
              <Fragment key={i}>
                {line
                  .filter((token) => !token.empty)
                  .map((token, j) => (
                    <span key={j} {...getTokenProps({ token })} />
                  ))}
                {'\n'}
              </Fragment>
            ))}
          </code>
        </pre>
      )}
    </Highlight>
  )
}
