import { createFileRoute, notFound } from '@tanstack/react-router'

import { BlogPostLayout } from '@/components/BlogPostLayout'
import { MdxComponents } from '@/components/mdx'
import { NotFound } from '@/components/NotFound'
import { getBlogPostBySlug } from '@/lib/blog'
import { BlogPostJsonLd, blogPostMetadata } from '@/lib/blog-metadata'
import { type MdxModule, tocSections } from '@/lib/mdx-content'
import { toRouteHead } from '@/lib/route-head'

const POSTS = import.meta.glob<MdxModule>('../content/blog/*/index.mdx', {
  eager: true,
})

const BY_SLUG = new Map<string, MdxModule>(
  Object.entries(POSTS).map(([path, mod]) => [
    path.replace(/.*\/content\/blog\//, '').replace(/\/index\.mdx$/, ''),
    mod,
  ]),
)

export const Route = createFileRoute('/blog/$slug')({
  // The miss is caught here rather than in the component so the response
  // carries a 404: a component that throws mid-render has already been given a
  // 200, and an unknown post answered like a real one.
  loader: ({ params }) => {
    if (!BY_SLUG.has(params.slug) || !getBlogPostBySlug(params.slug)) {
      throw notFound()
    }
  },
  head: ({ params }) => toRouteHead(blogPostMetadata(params.slug)),
  component: BlogPost,
  notFoundComponent: NotFound,
})

function BlogPost() {
  const { slug } = Route.useParams()
  const content = BY_SLUG.get(slug)
  const post = getBlogPostBySlug(slug)

  if (!content || !post) throw notFound()

  const Content = content.default

  return (
    <BlogPostLayout
      frontmatter={{ ...post, slug }}
      sections={tocSections(content.toc)}
    >
      <BlogPostJsonLd slug={slug} />
      <MdxComponents channel="latest">
        <Content />
      </MdxComponents>
    </BlogPostLayout>
  )
}
