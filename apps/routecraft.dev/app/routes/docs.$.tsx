import { createFileRoute, notFound, redirect } from '@tanstack/react-router'

import { DocsPageView } from '@/components/DocsPageView'
import { NotFound } from '@/components/NotFound'
import { docMetadata } from '@/lib/doc-metadata'
import { loadDocsPage } from '@/lib/docs-content'
import { docsMoveStatus, movedDocsPage } from '@/lib/docs-moves'
import { toRouteHead } from '@/lib/route-head'

export const Route = createFileRoute('/docs/$')({
  loader: async ({ params }) => {
    const page = await loadDocsPage('latest', params._splat ?? '')
    if (!page) {
      const moved = movedDocsPage('latest', params._splat ?? '')
      if (moved) {
        throw redirect({
          to: '/docs/$/',
          params: { _splat: moved.route },
          statusCode: docsMoveStatus(moved),
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
  head: ({ params }) => toRouteHead(docMetadata(params._splat ?? '')),
  component: ReleasedDocsPage,
  notFoundComponent: NotFound,
})

function ReleasedDocsPage() {
  const { _splat } = Route.useParams()
  return (
    <DocsPageView
      channel="latest"
      slug={_splat ?? ''}
      page={Route.useLoaderData()}
    />
  )
}
