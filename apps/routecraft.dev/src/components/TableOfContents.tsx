'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import clsx from 'clsx'

import { type Section, type Subsection } from '@/lib/sections'
import { Badge } from '@/components/Badge'

export function TableOfContents({
  tableOfContents,
}: {
  tableOfContents: Array<Section>
}) {
  const [currentSection, setCurrentSection] = useState(tableOfContents[0]?.id)

  const getHeadings = useCallback((tableOfContents: Array<Section>) => {
    return tableOfContents
      .flatMap((node) => [node.id, ...node.children.map((child) => child.id)])
      .map((id) => {
        const el = document.getElementById(id)
        if (!el) return null

        const style = window.getComputedStyle(el)
        const scrollMt = parseFloat(style.scrollMarginTop)

        const top = window.scrollY + el.getBoundingClientRect().top - scrollMt
        return { id, top }
      })
      .filter((x): x is { id: string; top: number } => x !== null)
  }, [])

  useEffect(() => {
    if (tableOfContents.length === 0) return
    const headings = getHeadings(tableOfContents)
    function onScroll() {
      const top = window.scrollY
      let current = headings[0].id
      for (const heading of headings) {
        if (top >= heading.top - 10) {
          current = heading.id
        } else {
          break
        }
      }
      setCurrentSection(current)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      window.removeEventListener('scroll', onScroll)
    }
  }, [getHeadings, tableOfContents])

  function isActive(section: Section | Subsection) {
    if (section.id === currentSection) {
      return true
    }
    if (!section.children) {
      return false
    }
    return section.children.findIndex(isActive) > -1
  }

  return (
    <div className="hidden xl:-mr-6 xl:block xl:flex-none xl:py-16 xl:pr-6">
      <nav aria-labelledby="on-this-page-title" className="w-56">
        {tableOfContents.length > 0 && (
          <>
            <h2
              id="on-this-page-title"
              className="flex items-center gap-3 font-mono text-[0.65rem] tracking-[0.22em] text-ink/70 uppercase dark:text-paper/70"
            >
              <span aria-hidden="true" className="h-1 w-1 bg-cobalt-500" />
              <span>On this page</span>
            </h2>
            <ol role="list" className="mt-5 space-y-3 text-sm">
              {tableOfContents.map((section) => (
                <li key={section.id}>
                  <h3 className="flex items-baseline gap-2">
                    <Link
                      href={`#${section.id}`}
                      className={clsx(
                        'transition',
                        isActive(section)
                          ? 'font-medium text-cobalt-500'
                          : 'text-ink/65 hover:text-ink dark:text-paper/65 dark:hover:text-paper',
                      )}
                    >
                      {section.title}
                    </Link>
                    {section.badges?.map((b, i) => (
                      <Badge key={i} color={b.color ?? 'yellow'}>
                        {b.text}
                      </Badge>
                    ))}
                  </h3>
                  {section.children.length > 0 && (
                    <ol
                      role="list"
                      className="mt-2 space-y-2 border-l border-ink/15 pl-4 text-sm dark:border-paper/15"
                    >
                      {section.children.map((subSection) => (
                        <li key={subSection.id}>
                          <div className="flex items-baseline gap-2">
                            <Link
                              href={`#${subSection.id}`}
                              className={clsx(
                                'transition',
                                isActive(subSection)
                                  ? 'font-medium text-cobalt-500'
                                  : 'text-ink/55 hover:text-ink dark:text-paper/55 dark:hover:text-paper',
                              )}
                            >
                              {subSection.title}
                            </Link>
                            {subSection.badges?.map((b, i) => (
                              <Badge key={i} color={b.color ?? 'yellow'}>
                                {b.text}
                              </Badge>
                            ))}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </nav>
    </div>
  )
}
