import type { Metadata } from 'next'
import Link from 'next/link'

import { RedirectToChangelog } from './redirect-to-changelog'

// Permanent home of the changelog is /changelog. This stub only exists to
// redirect inbound links to the previous /docs/changelog URL; it is excluded
// from indexing and canonicalises to the new location.
export const metadata: Metadata = {
  title: 'Changelog',
  alternates: { canonical: '/changelog/' },
  robots: { index: false, follow: true },
}

export default function ChangelogRedirectPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <RedirectToChangelog />
      <p className="text-ink/70">
        The changelog has moved to{' '}
        <Link href="/changelog/" className="text-cobalt-500 underline">
          /changelog
        </Link>
        .
      </p>
    </div>
  )
}
