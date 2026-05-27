'use client'

import { Fragment } from 'react'
import { Highlight } from 'prism-react-renderer'
import clsx from 'clsx'

export function CheatCode({
  children,
  language = 'ts',
  className,
}: {
  children: string
  language?: string
  className?: string
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
            'overflow-x-auto border border-ink/15 bg-paper-deep/40 px-3 py-2.5 text-[0.78rem] leading-relaxed dark:border-paper/15 dark:bg-ink/60 print:bg-white',
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
