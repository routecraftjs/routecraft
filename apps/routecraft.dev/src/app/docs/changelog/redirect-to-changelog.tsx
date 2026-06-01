'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// The changelog moved out of the versioned /docs namespace to top-level
// /changelog (it spans versions and ships on the main branch cadence, not a
// release ref). This client redirect keeps old /docs/changelog links working
// in the static export, where server-side redirects are unavailable.
export function RedirectToChangelog() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/changelog/')
  }, [router])

  return null
}
