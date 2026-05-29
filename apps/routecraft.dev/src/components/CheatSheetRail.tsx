'use client'

import { useEffect, useState } from 'react'
import clsx from 'clsx'

export interface RailItem {
  id: string
  title: string
}

export function CheatSheetRail({ items }: { items: RailItem[] }) {
  const [active, setActive] = useState<string | null>(items[0]?.id ?? null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const elements = items
      .map((i) => document.getElementById(i.id))
      .filter((el): el is HTMLElement => el !== null)
    if (elements.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the topmost entry that is intersecting; if none, fall back
        // to the last entry that was above the viewport.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
          )[0]
        if (visible) {
          setActive(visible.target.id)
        }
      },
      {
        rootMargin: '-96px 0px -60% 0px',
        threshold: 0,
      },
    )

    elements.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [items])

  return (
    <nav
      aria-label="Cheat sheet sections"
      className="sticky top-24 print:hidden"
    >
      <p className="flex items-center gap-2 font-mono text-[0.6rem] tracking-[0.22em] text-ink/55 uppercase">
        <span aria-hidden="true" className="h-1 w-1 bg-cobalt-500" />
        On this sheet
      </p>
      <ul
        role="list"
        className="mt-4 flex flex-col gap-0.5 border-l border-ink/15"
      >
        {items.map((item) => {
          const isActive = item.id === active
          return (
            <li key={item.id} className="relative">
              <a
                href={`#${item.id}`}
                aria-current={isActive ? 'true' : undefined}
                className={clsx(
                  'block py-1.5 pl-4 text-[0.82rem] leading-snug transition',
                  isActive
                    ? 'font-medium text-cobalt-500'
                    : 'text-ink/60 hover:text-ink',
                )}
              >
                {item.title}
              </a>
              {isActive && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0 -left-0.5 h-full w-0.5 bg-cobalt-500"
                />
              )}
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
