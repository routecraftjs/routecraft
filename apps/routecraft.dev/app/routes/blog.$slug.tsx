import { createFileRoute, notFound } from '@tanstack/react-router'

import { BlogPostLayout } from '@/components/BlogPostLayout'
import { MdxComponents } from '@/components/mdx'
import { getBlogPostBySlug } from '@/lib/blog'
import { type MdxModule, tocSections } from '@/lib/mdx-content'

const POSTS = import.meta.glob<MdxModule>('../content/blog/*/index.mdx', {
  eager: true,
})

const BY_SLUG = new Map<string, MdxModule>(
  Object.entries(POSTS).map(([path, module]) => [
    path.replace(/.*\/content\/blog\//, '').replace(/\/index\.mdx$/, ''),
    module,
  ]),
)

export const Route = createFileRoute('/blog/$slug')({
  component: BlogPost,
  notFoundComponent: () => <p>Not found</p>,
})

function BlogPost() {
  const { slug } = Route.useParams()
  const module = BY_SLUG.get(slug)
  const post = getBlogPostBySlug(slug)

  if (!module || !post) throw notFound()

  const Content = module.default

  return (
    <BlogPostLayout
      frontmatter={{ ...post, slug }}
      sections={tocSections(module.toc)}
    >
      <MdxComponents channel="latest">
        <Content />
      </MdxComponents>
    </BlogPostLayout>
  )
}
