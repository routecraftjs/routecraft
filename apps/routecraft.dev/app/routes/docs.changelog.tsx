import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * The changelog moved out of the docs tree, but the old URL is published and
 * pinned outside this repository. A server redirect replaces the client-side
 * stub the static export needed.
 */
export const Route = createFileRoute('/docs/changelog')({
  beforeLoad: () => {
    throw redirect({ to: '/changelog/', statusCode: 301 })
  },
})
