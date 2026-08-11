import { createFileRoute, notFound } from '@tanstack/react-router'

import { DocsPageView } from '@/components/DocsPageView'
import { docsPage } from '@/lib/docs-content'
import { docMetadata } from '@/lib/doc-metadata'
import { toRouteHead } from '@/lib/route-head'

export const Route = createFileRoute('/docs/next/$')({
  head: ({ params }) => toRouteHead(docMetadata(`next/${params._splat ?? ''}`)),
  component: NextDocsPage,
  notFoundComponent: () => <p>Not found</p>,
})

function NextDocsPage() {
  const { _splat } = Route.useParams()
  const page = docsPage('next', _splat ?? '')

  if (!page) throw notFound()

  return <DocsPageView channel="next" page={page} />
}
