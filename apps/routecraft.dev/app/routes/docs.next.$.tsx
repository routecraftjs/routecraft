import { createFileRoute, notFound, redirect } from '@tanstack/react-router'

import { DocsPageView } from '@/components/DocsPageView'
import { NotFound } from '@/components/NotFound'
import { docMetadata } from '@/lib/doc-metadata'
import { loadDocsPage } from '@/lib/docs-content'
import { movedDocsPage } from '@/lib/docs-moves'
import { toRouteHead } from '@/lib/route-head'

export const Route = createFileRoute('/docs/next/$')({
  loader: async ({ params }) => {
    const page = await loadDocsPage('next', params._splat ?? '')
    if (!page) {
      const moved = movedDocsPage('next', params._splat ?? '')
      if (moved) {
        throw redirect({
          to: '/docs/next/$/',
          params: { _splat: moved.route },
          statusCode: moved.status,
        })
      }
      throw notFound()
    }

    return {
      frontmatter: page.frontmatter ?? {},
      toc: page.toc ?? [],
      outlines: page.outlines ?? [],
    }
  },
  head: ({ params }) => toRouteHead(docMetadata(`next/${params._splat ?? ''}`)),
  component: NextDocsPage,
  notFoundComponent: NotFound,
})

function NextDocsPage() {
  const { _splat } = Route.useParams()
  return (
    <DocsPageView
      channel="next"
      slug={_splat ?? ''}
      page={Route.useLoaderData()}
    />
  )
}
