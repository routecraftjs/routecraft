declare module '*.mdx' {
  import type { ComponentType } from 'react'
  import type { TocEntry } from '@/lib/mdx-plugins'

  const MDXComponent: ComponentType<Record<string, unknown>>
  export const frontmatter: Record<string, unknown> | undefined
  export const toc: TocEntry[] | undefined
  export const outlines: string[] | undefined
  export default MDXComponent
}
