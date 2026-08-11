import { createFileRoute } from '@tanstack/react-router'

import { CheatSheet } from '../content/cheat-sheet/CheatSheet'

export const Route = createFileRoute('/cheat-sheet')({
  head: () => ({
    meta: [
      { title: 'Routecraft Cheat Sheet' },
      {
        name: 'description',
        content:
          'One-page reference for the Routecraft DSL: sources, destinations, operations, errors, and the CLI.',
      },
    ],
  }),
  component: CheatSheet,
})
