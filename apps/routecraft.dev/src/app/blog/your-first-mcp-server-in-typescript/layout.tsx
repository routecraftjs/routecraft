import { blogPostMetadata, BlogPostJsonLd } from '@/lib/blog-metadata'

const slug = 'your-first-mcp-server-in-typescript'

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
