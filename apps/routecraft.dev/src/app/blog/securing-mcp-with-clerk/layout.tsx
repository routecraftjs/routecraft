import { blogPostMetadata, BlogPostJsonLd } from '@/lib/blog-metadata'

const slug = 'securing-mcp-with-clerk'

export const metadata = blogPostMetadata(slug)

export default function PostLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <>
      {children}
      <BlogPostJsonLd slug={slug} />
    </>
  )
}
