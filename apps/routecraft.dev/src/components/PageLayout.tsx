import { type Node } from '@markdoc/markdoc'

import { DocsLayout } from '@/components/DocsLayout'
import {
  BlogPostLayout,
  type BlogPostFrontmatter,
} from '@/components/BlogPostLayout'
import { type BadgeColor } from '@/components/Badge'

type Frontmatter = {
  title?: string
  titleBadges?: Array<{ text: string; color?: BadgeColor }>
  layout?: string
} & BlogPostFrontmatter

export function PageLayout({
  children,
  frontmatter,
  nodes,
}: {
  children: React.ReactNode
  frontmatter: Frontmatter
  nodes: Array<Node>
}) {
  if (frontmatter?.layout === 'blog-post') {
    return (
      <BlogPostLayout frontmatter={frontmatter} nodes={nodes}>
        {children}
      </BlogPostLayout>
    )
  }
  return (
    <DocsLayout frontmatter={frontmatter} nodes={nodes}>
      {children}
    </DocsLayout>
  )
}
