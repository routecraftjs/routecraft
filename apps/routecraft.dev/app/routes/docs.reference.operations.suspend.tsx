import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * The operation was renamed from `suspend` to `defer` in 0.7.0 and this page
 * moved with it. The old URL was published for the whole canary and is the one
 * an LLM has cached, so it redirects rather than 404s.
 *
 * The target goes through the `/docs/$` splat with its `_splat` param rather
 * than as a literal path: content pages are served by that route, so they are
 * not members of the typed route union and a literal target does not compile.
 */
export const Route = createFileRoute('/docs/reference/operations/suspend')({
  beforeLoad: () => {
    throw redirect({
      to: '/docs/$/',
      params: { _splat: 'reference/operations/defer' },
      statusCode: 301,
    })
  },
})
