import { createFileRoute, notFound } from '@tanstack/react-router'

import { DocsPageView } from '@/components/DocsPageView'
import { docsPage } from '@/lib/docs-content'

export const Route = createFileRoute('/docs/next/$')({
  component: NextDocsPage,
  notFoundComponent: () => <p>Not found</p>,
})

function NextDocsPage() {
  const { _splat } = Route.useParams()
  const page = docsPage('next', _splat ?? '')

  if (!page) throw notFound()

  return <DocsPageView channel="next" page={page} />
}
