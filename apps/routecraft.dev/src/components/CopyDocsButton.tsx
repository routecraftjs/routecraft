'use client'

import { useState } from 'react'
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

type CopiedState = null | 'page' | 'pageLink' | 'allDocs' | 'allDocsLink'

export function CopyDocsButton() {
  const pathname = usePathname()
  const [copied, setCopied] = useState<CopiedState>(null)

  async function copyToClipboard(text: string, state: CopiedState) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(state)
      setTimeout(() => setCopied(null), 1500)
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
      </MenuItems>
    </Menu>
  )
}
