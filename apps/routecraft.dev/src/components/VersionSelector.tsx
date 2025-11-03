'use client'

import {
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
} from '@headlessui/react'
import clsx from 'clsx'

const versions = [{ label: 'v0.1.1', value: 'v0.1.1' }]

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

export function VersionSelector(
  props: React.ComponentPropsWithoutRef<typeof Listbox<'div'>>,
) {
  return (
    <Listbox
      as="div"
      value={versions[0].value}
      onChange={() => {
        // TODO: implement version switching logic
      }}
      {...props}
    >
      <div className="relative">
        <ListboxButton
          className={clsx(
            'inline-flex h-7 items-center gap-2 rounded-full px-3 text-sm font-semibold transition-colors',
            'bg-slate-100 text-slate-900 hover:bg-slate-200',
            'dark:bg-slate-900/80 dark:text-slate-100 dark:hover:bg-slate-900/90',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-100',
            'dark:focus-visible:ring-offset-slate-950',
          )}
          aria-label="Documentation version"
        >
          <span>v0.1.1</span>
          <ChevronDownIcon className="h-4 w-4 text-slate-400 dark:text-slate-300" />
        </ListboxButton>
        <ListboxOptions className="absolute top-[calc(100%+0.5rem)] right-0 z-50 w-36 space-y-1 rounded-xl bg-white p-2 text-sm font-medium text-slate-700 shadow-sm dark:bg-slate-900 dark:text-slate-100">
          {versions.map((version) => (
            <ListboxOption
              key={version.value}
              value={version.value}
              className={({ active, selected }) =>
                clsx(
                  'flex cursor-pointer items-center rounded-lg px-3 py-2 transition-colors select-none',
                  (active || selected) &&
                    'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-white',
                  !active && !selected && 'text-slate-400 dark:text-slate-500',
                )
              }
            >
              {version.label}
            </ListboxOption>
          ))}
        </ListboxOptions>
      </div>
    </Listbox>
  )
}
