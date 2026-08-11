import { createFileRoute } from '@tanstack/react-router'

import { CheatSheet } from '../content/cheat-sheet/CheatSheet'
import { absoluteUrl, canonicalPath, siteName } from '@/lib/site'

export const Route = createFileRoute('/cheat-sheet')({
  head: () => ({
    meta: [
      { title: `Routecraft Cheat Sheet - ${siteName}` },
      {
        name: 'description',
        content:
          'One-page reference for the Routecraft DSL: sources, destinations, operations, errors, and the CLI.',
      },
    ],
    links: [
      { rel: 'canonical', href: absoluteUrl(canonicalPath('/cheat-sheet')) },
    ],
  }),
  component: CheatSheet,
})
