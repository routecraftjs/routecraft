#!/usr/bin/env bun
/**
 * Renders every blog figure to a PNG under `public/images/figures/`.
 *
 * A figure is a DOM drawing: HTML and CSS scaled by ScaledFrame, which only a
 * browser lays out. There is no vector form to export (the drawing is not SVG),
 * and Satori, which renders the OG images, cannot lay one out either. So the
 * export drives a real browser over the built `/figures/<id>/` pages and
 * screenshots the figure element.
 *
 * The PNGs are committed rather than built in CI: they change only when a
 * figure changes, and keeping them out of the build means the Pages workflow
 * never has to install a browser.
 *
 *   bun run build && bun run figures:export        # all figures
 *   bun run figures:export four-gates              # just one
 *
 * Chromium is downloaded once, on first use:
 *
 *   bunx playwright install chromium
 *
 * The script sticks to APIs both Bun and Node have, so it runs under either.
 */
import { createReadStream } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'
import sharp from 'sharp'

import {
  FIGURE_DARK_SUFFIX,
  FIGURE_EXPORT_ATTRIBUTE,
  FIGURE_EXPORT_SCALE,
  FIGURE_IMAGE_DIR,
  FIGURE_THEMES,
  figureImagePath,
} from '../src/lib/figure-image'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(appRoot, 'out')
const imageDir = path.join(appRoot, 'public', FIGURE_IMAGE_DIR)

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

/**
 * Figure ids come from the built export rather than the source module, so the
 * script can only ever screenshot a page that actually exists.
 */
async function figureIds(): Promise<string[]> {
  let entries
  try {
    entries = await readdir(path.join(outDir, 'figures'), {
      withFileTypes: true,
    })
  } catch {
    throw new Error(
      `No built figure pages in ${outDir}. Run \`bun run build\` in apps/routecraft.dev first.`,
    )
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/** Serves the static export so the pages load their own fonts and CSS. */
async function serveExport(): Promise<{ origin: string; close: () => void }> {
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(
      new URL(request.url ?? '/', 'http://localhost').pathname,
    )
    const target = path.join(
      outDir,
      pathname.endsWith('/') ? `${pathname}index.html` : pathname,
    )
    // The server is local and short-lived, but a traversal would silently read
    // outside the export, so keep it honest.
    if (!target.startsWith(`${outDir}${path.sep}`)) {
      response.writeHead(403).end('Forbidden')
      return
    }
    stat(target).then(
      () => {
        response.writeHead(200, {
          'content-type':
            CONTENT_TYPES[path.extname(target)] ?? 'application/octet-stream',
        })
        createReadStream(target).pipe(response)
      },
      () => {
        response.writeHead(404).end('Not found')
      },
    )
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  }
}

async function main() {
  const requested = process.argv.slice(2)
  const available = await figureIds()
  const unknown = requested.filter((id) => !available.includes(id))
  if (unknown.length > 0) {
    throw new Error(
      `Unknown figure id(s): ${unknown.join(', ')}. Available: ${available.join(', ')}`,
    )
  }
  const ids = requested.length > 0 ? requested : available
  if (ids.length === 0) throw new Error('No figures to export.')

  // The dark file is the id plus a suffix, so an id already ending in it would
  // overwrite another figure's dark export.
  const colliding = ids.filter((id) => id.endsWith(FIGURE_DARK_SUFFIX))
  if (colliding.length > 0) {
    throw new Error(
      `Figure id(s) ending in "${FIGURE_DARK_SUFFIX}" collide with the dark export: ${colliding.join(', ')}`,
    )
  }

  await mkdir(imageDir, { recursive: true })

  const server = await serveExport()
  // A listening server holds the event loop open, so a launch failure here has
  // to close it or the CLI prints the hint and then hangs instead of exiting.
  const browser = await chromium.launch().catch((error: unknown) => {
    server.close()
    throw new Error(
      `Could not launch Chromium. Install it with \`bunx playwright install chromium\`.\n${String(error)}`,
    )
  })
  try {
    for (const theme of FIGURE_THEMES) {
      // The figures re-tone with the site theme, and next-themes follows the
      // system preference when nothing is stored. A fresh context has no
      // localStorage, so the emulated colour scheme is the whole control: no
      // clicking the theme selector, no seeding a preference.
      const context = await browser.newContext({
        colorScheme: theme,
        deviceScaleFactor: FIGURE_EXPORT_SCALE,
      })

      try {
        for (const id of ids) {
          const page = await context.newPage()
          try {
            const response = await page.goto(`${server.origin}/figures/${id}/`)
            if (!response?.ok()) {
              throw new Error(
                `/figures/${id}/ returned ${response?.status() ?? 'no response'}`,
              )
            }

            // Dark is applied by next-themes after hydration, so the served
            // HTML is light until the class lands: capturing early would write
            // a light figure to the dark file. Light needs no such gate, since
            // the server-rendered and hydrated states are identical.
            if (theme === 'dark') {
              await page.waitForFunction(() =>
                document.documentElement.classList.contains('dark'),
              )
            }
            await page.evaluate(() =>
              document.fonts.ready.then(() => undefined),
            )

            // Lift the figure out of the page before capturing. Every ancestor
            // is a scroller or a max-width column that would crop a canvas
            // wider than the viewport, and none of them belong in the image.
            const size = await page.evaluate((attribute) => {
              const element = document.querySelector<HTMLElement>(
                `[${attribute}]`,
              )
              if (!element) {
                throw new Error(`No [${attribute}] element on the page`)
              }
              document.body.replaceChildren(element)
              document.body.style.margin = '0'
              document.body.style.display = 'block'
              const { width, height } = element.getBoundingClientRect()
              return { width: Math.ceil(width), height: Math.ceil(height) }
            }, FIGURE_EXPORT_ATTRIBUTE)

            // A viewport that already fits the figure keeps the capture to one
            // paint, rather than scroll-and-stitch for a tall canvas.
            await page.setViewportSize(size)
            const shot = await page
              .locator(`[${FIGURE_EXPORT_ATTRIBUTE}]`)
              .screenshot({ type: 'png' })

            const png = await sharp(shot)
              .png({ compressionLevel: 9, effort: 10 })
              .toBuffer()
            const file = path.basename(figureImagePath(id, theme))
            await writeFile(path.join(imageDir, file), png)

            const scaled = `${size.width * FIGURE_EXPORT_SCALE}x${size.height * FIGURE_EXPORT_SCALE}`
            console.log(
              `${file}  ${scaled}  ${Math.round(png.byteLength / 1024)} kB`,
            )
          } finally {
            await page.close()
          }
        }
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
    server.close()
  }

  console.log(
    `\n${ids.length} figure(s) in ${FIGURE_THEMES.length} themes written to public/${FIGURE_IMAGE_DIR}/`,
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
