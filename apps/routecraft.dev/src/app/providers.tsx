'use client'

import { type ReactNode, useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import posthog from 'posthog-js'
import { PostHogProvider as PHProvider } from 'posthog-js/react'
import { ThemeProvider } from 'next-themes'

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY
const POSTHOG_HOST =
  process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com'

function PosthogClient({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const hasInitializedRef = useRef(false)

  useEffect(() => {
    if (
      !POSTHOG_KEY ||
      typeof window === 'undefined' ||
      hasInitializedRef.current
    ) {
      return
    }

    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      ui_host: 'https://eu.posthog.com',
      capture_pageview: false,
      capture_pageleave: true,
      capture_performance: true,
      capture_exceptions: true,
      person_profiles: 'identified_only',
      debug: process.env.NODE_ENV === 'development',
    })

    hasInitializedRef.current = true
  }, [])

  useEffect(() => {
    if (
      !POSTHOG_KEY ||
      typeof window === 'undefined' ||
      !hasInitializedRef.current
    ) {
      return
    }

    // Use PostHog's built-in pageview method
    posthog.capture('$pageview')
  }, [pathname])

  if (!POSTHOG_KEY) {
    return <>{children}</>
  }

  return <PHProvider client={posthog}>{children}</PHProvider>
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <PosthogClient>
      <ThemeProvider attribute="class" disableTransitionOnChange>
        {children}
      </ThemeProvider>
    </PosthogClient>
  )
}
