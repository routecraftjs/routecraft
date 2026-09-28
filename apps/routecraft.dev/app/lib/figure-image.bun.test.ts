import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'

import {
  FIGURE_TEXT,
  figureImagePath,
} from '../components/figures/manifest.mjs'

const publicDir = path.join(import.meta.dir, '..', '..', 'public')

describe('figure PNG exports', () => {
  /**
   * @case Every figure in the manifest has its committed light and dark PNG
   * @preconditions The manifest lists each figure the site renders, lightboxes and prerenders
   * @expectedResult Both files exist under public/, so no figure enlarges to a broken image
   */
  test.each(Object.keys(FIGURE_TEXT))('%s has a light and a dark PNG', (id) => {
    for (const theme of ['light', 'dark'] as const) {
      const file = path.join(publicDir, figureImagePath(id, theme))
      expect(existsSync(file), file).toBe(true)
    }
  })
})
