import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * The page moved up from Advanced to Introduction when the docs were
 * re-cut around the platform: reaching a harness from an editor is a first
 * hour concept, not depth. The old URL was published for all of 0.7 and is
 * what an LLM has cached, so it redirects rather than 404s.
 *
 * The target goes through the `/docs/$` splat with its `_splat` param rather
 * than as a literal path: content pages are served by that route, so they are
 * not members of the typed route union and a literal target does not compile.
 */
export const Route = createFileRoute('/docs/advanced/talk-from-your-editor')({
  beforeLoad: () => {
    throw redirect({
      to: '/docs/$/',
      params: { _splat: 'introduction/talk-from-your-editor' },
      statusCode: 301,
    })
  },
})
