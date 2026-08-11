import { Link, useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import type { ComponentProps, ReactNode } from 'react'

type AppLinkProps = Omit<ComponentProps<typeof Link>, 'to'> & {
  href: string
  children?: ReactNode
}

/**
 * Router link that accepts an arbitrary string `href`.
 *
 * Docs, blog and navigation hrefs come from content and generated data, so they
 * are resolved at runtime and cannot satisfy the router's literal route union.
 * This module owns the cast so no call site needs one.
 */
export function AppLink({ href, ...props }: AppLinkProps) {
  return <Link to={href as never} {...props} />
}

/**
 * Imperative counterpart to {@link AppLink}: navigates to a runtime string href.
 */
export function useAppNavigate() {
  const navigate = useNavigate()

  return useCallback(
    (href: string) => {
      void navigate({ to: href as never })
    },
    [navigate],
  )
}
