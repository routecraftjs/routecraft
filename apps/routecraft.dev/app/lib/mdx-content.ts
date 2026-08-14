import type { ComponentType } from 'react'

import type { TocEntry } from '@/lib/mdx-plugins'
import type { Section } from '@/lib/sections'

export interface MdxModule {
  default: ComponentType
  frontmatter?: Record<string, unknown>
  toc?: TocEntry[]
  outlines?: string[]
}

/** Adapts a page's exported table of contents to the sidebar's shape. */
export function tocSections(toc: TocEntry[] | undefined): Section[] {
  return (toc ?? []).map((entry) => ({
    level: 2 as const,
    id: entry.id,
    title: entry.title,
    children: entry.children.map((child) => ({
      level: 3 as const,
      id: child.id,
      title: child.title,
    })),
  }))
}
