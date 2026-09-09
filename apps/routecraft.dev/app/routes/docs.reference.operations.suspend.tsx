import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * The operation was renamed from `suspend` to `defer` in 0.7.0 and this page
 * moved with it. The old URL was published for the whole canary and is the one
 * an LLM has cached, so it redirects rather than 404s.
 */
export const Route = createFileRoute('/docs/reference/operations/suspend')({
  beforeLoad: () => {
    throw redirect({ to: '/docs/reference/operations/defer/', statusCode: 301 })
  },
})
