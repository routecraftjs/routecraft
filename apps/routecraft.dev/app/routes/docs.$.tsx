import { createFileRoute, notFound } from '@tanstack/react-router'

import { DocsPageView } from '@/components/DocsPageView'
import { docsPage } from '@/lib/docs-content'

export const Route = createFileRoute('/docs/$')({
  component: ReleasedDocsPage,
  notFoundComponent: () => <p>Not found</p>,
})

function ReleasedDocsPage() {
  const { _splat } = Route.useParams()
  const page = docsPage('latest', _splat ?? '')

  if (!page) throw notFound()

  return <DocsPageView channel="latest" page={page} />
}
