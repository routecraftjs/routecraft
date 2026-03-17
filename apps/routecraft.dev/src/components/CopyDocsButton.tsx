'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react'
import clsx from 'clsx'

import {
  getPageMarkdown,
  getAllDocsMarkdown,
  getPageRawUrl,
  getAllDocsRawUrl,
} from '@/markdoc/docs-markdown.mjs'

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ''

function CopyIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg
      viewBox="0 0 448 512"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M208 0H332.1c12.7 0 24.9 5.1 33.9 14.1l67.9 67.9c9 9 14.1 21.2 14.1 33.9V336c0 26.5-21.5 48-48 48H208c-26.5 0-48-21.5-48-48V48c0-26.5 21.5-48 48-48zM48 128h80v64H64V448H256V416h64v48c0 26.5-21.5 48-48 48H48c-26.5 0-48-21.5-48-48V176c0-26.5 21.5-48 48-48z" />
    </svg>
  )
}

function CheckIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
  )
}

function ChevronDownIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
      {...props}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  )
}

function LinkIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

function DocsIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  )
}

function ClaudeIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z" />
    </svg>
  )
}

type CopiedState = null | 'page' | 'pageLink' | 'allDocs' | 'allDocsLink'

export function CopyDocsButton() {
  const pathname = usePathname()
  const [copied, setCopied] = useState<CopiedState>(null)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    }
  }, [])

  async function copyToClipboard(text: string, state: CopiedState) {
    try {
      await navigator.clipboard.writeText(text)
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      setCopied(state)
      copyTimeoutRef.current = setTimeout(() => setCopied(null), 1500)
    } catch {
      // Silently ignore copy errors
    }
  }

  function handleCopyPage() {
    const md = getPageMarkdown(pathname)
    if (md) copyToClipboard(md, 'page')
  }

  function handleCopyPageLink() {
    const rawUrl = getPageRawUrl(pathname, basePath)
    const fullUrl = `${window.location.origin}${rawUrl}`
    copyToClipboard(fullUrl, 'pageLink')
  }

  function handleCopyAllDocs() {
    const md = getAllDocsMarkdown()
    copyToClipboard(md, 'allDocs')
  }

  function handleCopyAllDocsLink() {
    const rawUrl = getAllDocsRawUrl(basePath)
    const fullUrl = `${window.location.origin}${rawUrl}`
    copyToClipboard(fullUrl, 'allDocsLink')
  }

  function handleOpenInClaude() {
    const rawUrl = getAllDocsRawUrl(basePath)
    const docsUrl = `${window.location.origin}${rawUrl}`
    const prompt = `I'd like to discuss the content from ${docsUrl}`
    window.open(
      `https://claude.ai/new?q=${encodeURIComponent(prompt)}`,
      '_blank',
    )
  }

  const buttonBaseClass = clsx(
    'inline-flex items-center gap-1.5 text-sm font-medium transition-colors',
    'text-gray-500 hover:text-gray-700',
    'dark:text-gray-400 dark:hover:text-gray-200',
  )

  return (
    <Menu as="div" className="relative inline-flex">
      <div
        className={clsx(
          'inline-flex items-center rounded-lg border transition-colors',
          'border-gray-200 bg-white',
          'dark:border-gray-700 dark:bg-gray-800/50',
        )}
      >
        {/* Primary copy button */}
        <button
          type="button"
          onClick={handleCopyPage}
          className={clsx(
            buttonBaseClass,
            'rounded-l-lg py-1.5 pr-2 pl-2.5',
            'hover:bg-gray-50 dark:hover:bg-gray-800',
          )}
        >
          {copied === 'page' ? (
            <CheckIcon className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <CopyIcon className="h-3.5 w-3.5" />
          )}
          <span>{copied === 'page' ? 'Copied' : 'Copy page'}</span>
        </button>

        {/* Dropdown trigger */}
        <MenuButton
          className={clsx(
            'rounded-r-lg border-l px-1.5 py-1.5 transition-colors',
            'border-gray-200 hover:bg-gray-50',
            'dark:border-gray-700 dark:hover:bg-gray-800',
            'text-gray-400 hover:text-gray-600',
            'dark:text-gray-500 dark:hover:text-gray-300',
          )}
          aria-label="More copy options"
        >
          <ChevronDownIcon className="h-4 w-4" />
        </MenuButton>
      </div>

      <MenuItems
        className={clsx(
          'absolute top-[calc(100%+0.5rem)] right-0 z-50 w-56 rounded-xl p-1.5 shadow-lg ring-1 ring-black/5',
          'bg-white dark:bg-gray-800 dark:ring-white/10',
        )}
      >
        <MenuItem>
          {({ focus }) => (
            <button
              type="button"
              onClick={handleCopyAllDocs}
              className={clsx(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                focus
                  ? 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white'
                  : 'text-gray-600 dark:text-gray-300',
              )}
            >
              <DocsIcon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
              <span>{copied === 'allDocs' ? 'Copied!' : 'Copy all docs'}</span>
            </button>
          )}
        </MenuItem>

        <MenuItem>
          {({ focus }) => (
            <button
              type="button"
              onClick={handleCopyPageLink}
              className={clsx(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                focus
                  ? 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white'
                  : 'text-gray-600 dark:text-gray-300',
              )}
            >
              <LinkIcon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
              <span>
                {copied === 'pageLink' ? 'Copied!' : 'Copy page link'}
              </span>
            </button>
          )}
        </MenuItem>

        <MenuItem>
          {({ focus }) => (
            <button
              type="button"
              onClick={handleCopyAllDocsLink}
              className={clsx(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                focus
                  ? 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white'
                  : 'text-gray-600 dark:text-gray-300',
              )}
            >
              <LinkIcon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
              <span>
                {copied === 'allDocsLink' ? 'Copied!' : 'Copy all docs link'}
              </span>
            </button>
          )}
        </MenuItem>

        <div className="mx-3 my-1 border-t border-gray-100 dark:border-gray-700" />

        <MenuItem>
          {({ focus }) => (
            <button
              type="button"
              onClick={handleOpenInClaude}
              className={clsx(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                focus
                  ? 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white'
                  : 'text-gray-600 dark:text-gray-300',
              )}
            >
              <ClaudeIcon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
              <span>Chat in Claude.ai</span>
            </button>
          )}
        </MenuItem>
      </MenuItems>
    </Menu>
  )
}
