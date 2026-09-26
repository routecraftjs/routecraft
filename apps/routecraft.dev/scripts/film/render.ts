/**
 * Records the platform film to `public/film/routecraft-platform.mp4`.
 *
 * `FilmFrame` draws any moment of the film from its time alone, so this script
 * bundles it into a bare page, asks for every frame in turn, and pipes the
 * screenshots to ffmpeg together with the score. Nothing is screen-recorded in
 * real time, so a slow machine produces the same file as a fast one.
 *
 * Needs ffmpeg on PATH (or FFMPEG pointing at one) and a Playwright Chromium
 * (CHROMIUM overrides the browser). Run `bun scripts/film/score.ts` first when
 * the timeline changes, so the music matches.
 *
 * Usage:
 *   bun scripts/film/render.ts                  full film at 30 fps
 *   bun scripts/film/render.ts --stills 12,44   PNG stills into scripts/film/stills
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

import {
  FILM_DURATION,
  FILM_HEIGHT,
  FILM_WIDTH,
} from '../../app/components/film/timeline'
import { ROOT } from '../paths'

const FPS = 30
const OUT = join(ROOT, 'public', 'film', 'routecraft-platform.mp4')
const SCORE = join(ROOT, 'public', 'film', 'score.mp3')
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg'

const stillsArg = process.argv.indexOf('--stills')
const stills =
  stillsArg === -1
    ? null
    : (process.argv[stillsArg + 1] ?? '').split(',').filter(Boolean).map(Number)

const work = mkdtempSync(join(tmpdir(), 'routecraft-film-'))
const built = await Bun.build({
  entrypoints: [join(import.meta.dir, 'capture.tsx')],
  outdir: work,
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
})
if (!built.success) {
  for (const log of built.logs) console.error(log)
  process.exit(1)
}

const fontCss = [
  '@fontsource-variable/ibm-plex-sans/index.css',
  '@fontsource-variable/fraunces/full.css',
  '@fontsource-variable/fraunces/full-italic.css',
  '@fontsource-variable/jetbrains-mono/index.css',
].map((css) => pathToFileURL(Bun.resolveSync(css, ROOT)).href)

writeFileSync(
  join(work, 'index.html'),
  `<!doctype html>
<html><head><meta charset="utf-8">
${fontCss.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n')}
<style>
  :root {
    --font-ibm-plex-sans: 'IBM Plex Sans Variable', sans-serif;
    --font-fraunces: 'Fraunces Variable', serif;
    --font-jetbrains-mono: 'JetBrains Mono Variable', monospace;
  }
  html, body { margin: 0; background: #f5f1e8; }
  #film { width: ${FILM_WIDTH}px; height: ${FILM_HEIGHT}px; }
</style></head>
<body><div id="film"></div><script src="./capture.js"></script></body></html>`,
)

const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
)
const page = await browser.newPage({
  viewport: { width: FILM_WIDTH, height: FILM_HEIGHT },
})
await page.goto(pathToFileURL(join(work, 'index.html')).href)

// Faces load when text first uses them, so touch every scene before waiting.
for (const t of [3, 12, 26, 35, 58, 69]) {
  await page.evaluate((time) => window.filmFrame(time), t)
}
await page.evaluate(() => document.fonts.ready)

const shoot = async (t: number) => {
  await page.evaluate((time) => window.filmFrame(time), t)
  return page.screenshot({ type: 'png' })
}

if (stills) {
  const dir = join(import.meta.dir, 'stills')
  mkdirSync(dir, { recursive: true })
  for (const t of stills) {
    writeFileSync(
      join(dir, `t${String(t).padStart(5, '0')}.png`),
      await shoot(t),
    )
    console.log(`still ✓ ${t}s`)
  }
} else {
  mkdirSync(dirname(OUT), { recursive: true })
  const audio = existsSync(SCORE)
    ? ['-i', SCORE, '-c:a', 'aac', '-b:a', '160k', '-shortest']
    : []
  const ffmpeg = Bun.spawn(
    [
      FFMPEG,
      '-v',
      'error',
      '-y',
      '-f',
      'image2pipe',
      '-framerate',
      String(FPS),
      '-i',
      '-',
      ...audio.slice(0, 2),
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-tune',
      'animation',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      ...audio.slice(2),
      OUT,
    ],
    { stdin: 'pipe', stderr: 'inherit' },
  )
  const frames = FILM_DURATION * FPS
  for (let frame = 0; frame < frames; frame++) {
    ffmpeg.stdin.write(await shoot(frame / FPS))
    if (frame % FPS === 0) process.stdout.write(`\rframe ${frame}/${frames}`)
  }
  await ffmpeg.stdin.end()
  if ((await ffmpeg.exited) !== 0) throw new Error('ffmpeg failed')
  console.log(`\n✓ ${OUT}`)
}

await browser.close()
rmSync(work, { recursive: true, force: true })
