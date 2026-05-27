'use client'

import clsx from 'clsx'

export function PrintButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className={clsx(
        'group inline-flex items-center gap-2 bg-cobalt-500 px-5 py-2.5 font-mono text-[0.7rem] tracking-[0.22em] text-paper uppercase transition hover:bg-cobalt-600 focus:outline-none',
        className,
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-4 w-4"
      >
        <path d="M5 2.75A2.75 2.75 0 0 1 7.75 0h4.5A2.75 2.75 0 0 1 15 2.75V5h-2V2.75c0-.414-.336-.75-.75-.75h-4.5a.75.75 0 0 0-.75.75V5H5V2.75z" />
        <path d="M4 7.5A2.5 2.5 0 0 0 1.5 10v3A2.5 2.5 0 0 0 4 15.5h1V14H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1.5h1a2.5 2.5 0 0 0 2.5-2.5v-3A2.5 2.5 0 0 0 16 7.5H4z" />
        <path d="M6 13.5h8V20H6v-6.5zm1.5 1.5V18.5h5V15h-5z" />
      </svg>
      <span>Save as PDF</span>
    </button>
  )
}
