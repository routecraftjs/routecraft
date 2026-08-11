import { Link, useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import type { ComponentProps, ReactNode } from 'react'

type AppLinkProps = Omit<ComponentProps<typeof Link>, 'to'> & {
  href: string
  children?: ReactNode
}

/**
 * Splits a path-with-fragment href into the parts the router models separately.
 *
 * The router is configured with `trailingSlash: 'always'`, and it appends that
 * slash to whatever it is handed as a path. A fragment left inside the path
 * therefore comes back out as `/docs/reference/errors#rc-5025/`, which is not
 * an id on the page, so every cross-page deep link lands at the top instead of
 * the section it names. Heading anchors are load-bearing here: content links to
 * them, search results carry them, and they are pinned outside this repository.
 */
function splitHref(href: string): { to: string; hash?: string } {
  const marker = href.indexOf('#')
  if (marker === -1) return { to: href }
  return { to: href.slice(0, marker), hash: href.slice(marker + 1) }
}

/**
 * Router link that accepts an arbitrary string `href`.
 *
 * Docs, blog and navigation hrefs come from content and generated data, so they
 * are resolved at runtime and cannot satisfy the router's literal route union.
 * This module owns the cast so no call site needs one.
 */
export function AppLink({ href, ...props }: AppLinkProps) {
  const { to, hash } = splitHref(href)
  return <Link to={to as never} hash={hash} {...props} />
}

/**
 * Imperative counterpart to {@link AppLink}: navigates to a runtime string href.
 */
export function useAppNavigate() {
  const navigate = useNavigate()

  return useCallback(
    (href: string) => {
      const { to, hash } = splitHref(href)
      void navigate({ to: to as never, hash })
    },
    [navigate],
  )
}
