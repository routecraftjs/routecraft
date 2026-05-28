import {
  createBlogOgImage,
  OG_CONTENT_TYPE,
  OG_SIZE,
} from '@/lib/blog-og-image'

export const size = OG_SIZE
export const contentType = OG_CONTENT_TYPE
export const alt = 'Securing MCP with Clerk'
export const dynamic = 'force-static'

export default async function Image() {
  return createBlogOgImage({ slug: 'securing-mcp-with-clerk' })
}
