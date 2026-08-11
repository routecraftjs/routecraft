import { createFileRoute } from '@tanstack/react-router'

import { BlogIndex } from '@/components/BlogIndex'
import { getPublishedPosts } from '@/lib/blog'

export const Route = createFileRoute('/blog/')({
  component: () => <BlogIndex posts={getPublishedPosts()} />,
})
