import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * The page moved down from Introduction to Advanced when the docs were
 * re-cut around the platform: the event bus is depth, not the first hour.
 * The old URL was published for all of 0.7, so it redirects rather than 404s.
 *
 * The target goes through the `/docs/$` splat with its `_splat` param rather
 * than as a literal path: content pages are served by that route, so they are
 * not members of the typed route union and a literal target does not compile.
 */
export const Route = createFileRoute('/docs/introduction/events')({
  beforeLoad: () => {
    throw redirect({
      to: '/docs/$/',
      params: { _splat: 'advanced/events' },
      statusCode: 301,
    })
  },
})
