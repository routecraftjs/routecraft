import { createFileRoute } from '@tanstack/react-router'
// Loads Start's route typings, which add the `server` option used below.
import type {} from '@tanstack/react-start'

import { docsMoveStatus, movedDocsPage } from '@/lib/docs-moves'

/**
 * Moved pages' markdown mirrors, at the address the channel still lacks.
 *
 * `public/raw` is served as static files, so this only answers a mirror that
 * is not there. Models and agents fetch `/raw/docs/*.md` from llms.txt and
 * their own caches, which outlive a move as much as an HTML link does, so the
 * mirror follows the same move table as the page.
 */
export const Route = createFileRoute('/raw/docs/$')({
  server: {
    handlers: {
      GET: ({ params }) => {
        const splat = params._splat ?? ''
        const next = splat.startsWith('next/')
        const slug = (next ? splat.slice('next/'.length) : splat).replace(
          /\.md$/,
          '',
        )
        const move = splat.endsWith('.md')
          ? movedDocsPage(next ? 'next' : 'latest', slug)
          : undefined
        if (!move) return new Response('Not found', { status: 404 })
        return new Response(null, {
          status: docsMoveStatus(move),
          headers: {
            Location: `/raw/docs/${next ? 'next/' : ''}${move.route}.md`,
          },
        })
      },
    },
  },
})
