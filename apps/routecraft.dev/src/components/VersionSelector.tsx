'use client'

import { useEffect, useState } from 'react'
import {
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
} from '@headlessui/react'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'

type Version = {
  label: string
  basePath: string
  default?: boolean
}

const currentLabel = process.env.NEXT_PUBLIC_DOC_VERSION ?? 'dev'
const currentBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? ''
const fallbackVersions: Version[] = [
  { label: currentLabel, basePath: currentBasePath },
]

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

export function VersionSelector(props: { className?: string }) {
  const [versions, setVersions] = useState<Version[]>(fallbackVersions)
  const pathname = usePathname()

  useEffect(() => {
    const controller = new AbortController()
    fetch('/versions.json', { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<Version[]>) : null))
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          setVersions(data)
        }
      })
      .catch(() => {
        // Manifest is optional; fall back to the build-time label.
      })
    return () => controller.abort()
  }, [])

  const current = versions.find((v) => v.label === currentLabel) ?? versions[0]

  const handleChange = (target: Version) => {
    if (target.basePath === currentBasePath) return
    const suffix = pathname.endsWith('/') ? pathname : `${pathname}/`
    const { search, hash } = window.location
    window.location.href = `${target.basePath}${suffix}${search}${hash}`
  }

  return (
    <Listbox<'div', Version>
      as="div"
      value={current}
      onChange={handleChange}
      by="label"
      className={props.className}
    >
      <div className="relative">
        <ListboxButton
          className={clsx(
            'group inline-flex items-center gap-2 border border-ink/15 bg-paper-deep/40 px-2.5 py-1.5 font-mono text-[0.7rem] tracking-[0.18em] uppercase transition focus:outline-none',
            'text-ink/70 hover:border-cobalt-500/40 hover:text-ink',
            'dark:border-paper/15 dark:bg-ink-soft/40 dark:text-paper/70 dark:hover:border-cobalt-400/40 dark:hover:text-paper',
          )}
          aria-label="Documentation version"
        >
          <span aria-hidden="true" className="h-1 w-1 bg-cobalt-500" />
          <span>{current.label}</span>
          <ChevronDownIcon className="h-3 w-3 text-ink/45 transition group-hover:text-cobalt-500 dark:text-paper/45 dark:group-hover:text-cobalt-300" />
        </ListboxButton>
        <ListboxOptions className="absolute top-[calc(100%+0.5rem)] right-0 z-50 w-40 border border-ink/15 bg-paper p-1 font-mono text-[0.7rem] tracking-[0.18em] uppercase shadow-[0_20px_60px_-30px_rgba(12,12,16,0.4)] dark:border-paper/15 dark:bg-ink-soft">
          {versions.map((version) => (
            <ListboxOption
              key={version.label}
              value={version}
              className={({ focus, selected }) =>
                clsx(
                  'flex cursor-pointer items-center gap-3 px-3 py-2 transition select-none',
                  {
                    'text-cobalt-500': selected,
                    'bg-paper-deep text-ink dark:bg-ink dark:text-paper':
                      focus && !selected,
                    'text-ink/70 dark:text-paper/70': !focus && !selected,
                  },
                )
              }
            >
              {({ selected }) => (
                <>
                  <span
                    aria-hidden="true"
                    className={clsx(
                      'h-1 w-1 transition',
                      selected ? 'bg-cobalt-500' : 'bg-ink/25 dark:bg-paper/25',
                    )}
                  />
                  <span>{version.label}</span>
                </>
              )}
            </ListboxOption>
          ))}
        </ListboxOptions>
      </div>
    </Listbox>
  )
}
