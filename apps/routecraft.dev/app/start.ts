import { createMiddleware, createStart } from '@tanstack/react-start'
import { canonicalPath } from '@/lib/site'

/** A real file extension, so a versioned slug such as `0.7-to-0.8` is still a page. */
const FILE_EXTENSION = /\.[a-z][a-z0-9]{0,4}$/i

/**
 * Sends a page URL without its trailing slash to the slash form with a 308.
 *
 * The router does the same normalisation itself, but always with a 307, and a
 * temporary redirect tells search engines the slashless URL may come back, so
 * they never consolidate it onto the canonical page. A file (`/llms.txt`,
 * `/raw/docs/x.md`) is left alone.
 */
const permanentTrailingSlash = createMiddleware().server(
  ({ request, next }) => {
    const { pathname, search } = new URL(request.url)
    if (pathname.endsWith('/') || FILE_EXTENSION.test(pathname)) return next()

    // Collapsed so `//evil.example` can never become a protocol-relative Location.
    const path = canonicalPath(pathname.replace(/^\/+/, '/'))
    return new Response(null, {
      status: 308,
      headers: { Location: `${path}${search}` },
    })
  },
)

export const startInstance = createStart(() => ({
  requestMiddleware: [permanentTrailingSlash],
}))
