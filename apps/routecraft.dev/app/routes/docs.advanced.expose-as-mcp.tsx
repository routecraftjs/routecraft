import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * The page moved up from Advanced to Introduction, renamed "Expose to an
 * agent", when the docs were re-cut around the platform: serving a capability
 * over MCP is the default, not depth. The old URL was published for all of
 * 0.7, so it redirects rather than 404s.
 *
 * The target goes through the `/docs/$` splat with its `_splat` param rather
 * than as a literal path: content pages are served by that route, so they are
 * not members of the typed route union and a literal target does not compile.
 */
export const Route = createFileRoute('/docs/advanced/expose-as-mcp')({
  beforeLoad: () => {
    throw redirect({
      to: '/docs/$/',
      params: { _splat: 'introduction/expose-to-an-agent' },
      statusCode: 301,
    })
  },
})
