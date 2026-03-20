'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react'
import clsx from 'clsx'

import { getPageMarkdown, getAllDocsRawUrl } from '@/markdoc/docs-markdown.mjs'

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

function OpenAIIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  )
}

type CopiedState = null | 'page' | 'allDocsUrl'

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

  function getAllDocsFullUrl() {
    const rawUrl = getAllDocsRawUrl(basePath)
    return `${window.location.origin}${rawUrl}`
  }

  function handleOpenInClaude() {
    const docsUrl = getAllDocsFullUrl()
    const prompt = `I'd like to discuss the content from ${docsUrl}`
    window.open(
      `https://claude.ai/new?q=${encodeURIComponent(prompt)}`,
      '_blank',
      'noopener,noreferrer',
    )
  }

  function handleOpenInChatGPT() {
    const docsUrl = getAllDocsFullUrl()
    const prompt = `I'd like to discuss the content from ${docsUrl}`
    window.open(
      `https://chatgpt.com/?model=o3&q=${encodeURIComponent(prompt)}`,
      '_blank',
      'noopener,noreferrer',
    )
  }

  function handleCopyPage() {
    const md = getPageMarkdown(pathname)
    if (md) copyToClipboard(md, 'page')
  }

  function handleCopyAllDocsUrl() {
    copyToClipboard(getAllDocsFullUrl(), 'allDocsUrl')
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
        {/* Primary button: Chat with docs in Claude */}
        <button
          type="button"
          onClick={handleOpenInClaude}
          className={clsx(
            buttonBaseClass,
            'rounded-l-lg py-1.5 pr-2 pl-2.5',
            'hover:bg-gray-50 dark:hover:bg-gray-800',
          )}
        >
          <ClaudeIcon className="h-3.5 w-3.5" />
          <span>Ask Claude</span>
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
          aria-label="More options"
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
              onClick={handleOpenInChatGPT}
              className={clsx(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                focus
                  ? 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white'
                  : 'text-gray-600 dark:text-gray-300',
              )}
            >
              <OpenAIIcon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
              <span>Ask ChatGPT</span>
            </button>
          )}
        </MenuItem>

        <div className="mx-3 my-1 border-t border-gray-100 dark:border-gray-700" />

        <MenuItem>
          {({ focus }) => (
            <button
              type="button"
              onClick={handleCopyPage}
              className={clsx(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                focus
                  ? 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white'
                  : 'text-gray-600 dark:text-gray-300',
              )}
            >
              <CopyIcon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
              <span>{copied === 'page' ? 'Copied!' : 'Copy page'}</span>
            </button>
          )}
        </MenuItem>

        <MenuItem>
          {({ focus }) => (
            <button
              type="button"
              onClick={handleCopyAllDocsUrl}
              className={clsx(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                focus
                  ? 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white'
                  : 'text-gray-600 dark:text-gray-300',
              )}
            >
              <LinkIcon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
              <span>
                {copied === 'allDocsUrl' ? 'Copied!' : 'Copy raw docs URL'}
              </span>
            </button>
          )}
        </MenuItem>
      </MenuItems>
    </Menu>
  )
}
