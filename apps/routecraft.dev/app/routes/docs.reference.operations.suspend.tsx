import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * `.defer()` became `.defer()` in 0.7.0, so this page moved with it. The old
 * URL was published for the whole canary and is the one an LLM has cached.
 */
export const Route = createFileRoute('/docs/reference/operations/defer')({
  beforeLoad: () => {
    throw redirect({ to: '/docs/reference/operations/defer/', statusCode: 301 })
  },
})
