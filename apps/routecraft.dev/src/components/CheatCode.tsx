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
    <Highlight code={code} language={language} theme={{ plain: {}, styles: [] }}>
      {({ className: prismClassName, style, tokens, getTokenProps }) => (
        <pre
          className={clsx(
            prismClassName,
            'overflow-x-auto rounded-lg bg-gray-50 px-3 py-2 text-[0.78rem] leading-relaxed shadow-none ring-1 ring-gray-200 print:bg-white print:ring-gray-300 dark:bg-gray-950/60 dark:ring-gray-800',
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
