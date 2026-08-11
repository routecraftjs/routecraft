import { createFileRoute, notFound } from '@tanstack/react-router'

import { DocsPageView } from '@/components/DocsPageView'
import { docsPage } from '@/lib/docs-content'
import { docMetadata } from '@/lib/doc-metadata'
import { toRouteHead } from '@/lib/route-head'

export const Route = createFileRoute('/docs/$')({
  head: ({ params }) => toRouteHead(docMetadata(`${params._splat ?? ''}`)),
  component: ReleasedDocsPage,
  notFoundComponent: () => <p>Not found</p>,
})

function ReleasedDocsPage() {
  const { _splat } = Route.useParams()
  const page = docsPage('latest', _splat ?? '')

  if (!page) throw notFound()

  return <DocsPageView channel="latest" page={page} />
}
