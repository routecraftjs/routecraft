'use client'

import { Fragment, useState } from 'react'
import clsx from 'clsx'
import { Highlight } from 'prism-react-renderer'

export function Fence({
  children,
  language,
  offsetTop,
}: {
  children: string
  language: string
  offsetTop?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const code = children.trimEnd()

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore copy errors silently
    }
  }
  return (
    <div className="group relative">
      <Highlight
        code={code}
        language={language || 'txt'}
        theme={{ plain: {}, styles: [] }}
      >
        {({ className, style, tokens, getTokenProps }) => (
          <pre
            className={clsx(className, offsetTop && 'pt-10', 'mt-0')}
            style={style}
          >
            <code>
              {tokens.map((line, lineIndex) => (
                <Fragment key={lineIndex}>
                  {line
                    .filter((token) => !token.empty)
                    .map((token, tokenIndex) => (
                      <span key={tokenIndex} {...getTokenProps({ token })} />
                    ))}
                  {'\n'}
                </Fragment>
              ))}
            </code>
          </pre>
        )}
      </Highlight>
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy code"
        className="absolute top-3 right-3 rounded-md bg-slate-700/70 px-2 py-1 text-xs font-medium text-slate-200 opacity-0 transition group-hover:opacity-100 dark:bg-slate-700/60"
      >
        <span className="sr-only">{copied ? 'Copied' : 'Copy'}</span>
        {copied ? (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 448 512"
            fill="currentColor"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path d="M208 0H332.1c12.7 0 24.9 5.1 33.9 14.1l67.9 67.9c9 9 14.1 21.2 14.1 33.9V336c0 26.5-21.5 48-48 48H208c-26.5 0-48-21.5-48-48V48c0-26.5 21.5-48 48-48zM48 128h80v64H64V448H256V416h64v48c0 26.5-21.5 48-48 48H48c-26.5 0-48-21.5-48-48V176c0-26.5 21.5-48 48-48z" />
          </svg>
        )}
      </button>
    </div>
  )
}
