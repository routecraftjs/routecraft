import { createMiddleware, createStart } from '@tanstack/react-start'

/**
 * Sends a page URL without its trailing slash to the slash form with a 308.
 *
 * The router does the same normalisation itself, but always with a 307, and a
 * temporary redirect tells search engines the slashless URL may come back, so
 * they never consolidate it onto the canonical page. A path whose last segment
 * has an extension is a file (`/llms.txt`, `/raw/docs/x.md`) and is left alone.
 */
const permanentTrailingSlash = createMiddleware().server(
  ({ request, next }) => {
    const url = new URL(request.url)
    const lastSegment = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
    if (url.pathname.endsWith('/') || lastSegment.includes('.')) return next()

    return new Response(null, {
      status: 308,
      headers: { Location: `${url.pathname}/${url.search}` },
    })
  },
)

export const startInstance = createStart(() => ({
  requestMiddleware: [permanentTrailingSlash],
}))
