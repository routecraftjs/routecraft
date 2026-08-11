import { test, expect, chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3102'
const WIDTHS = [320, 375, 414, 768, 834, 1024, 1280]
const KEY_PATHS = [
  '/',
  '/docs/introduction/',
  '/docs/reference/adapters/cosine/',
  '/docs/reference/adapters/http/',
  '/docs/advanced/filter-chain/',
  '/docs/migrating/0.5-to-0.6/',
  '/docs/advanced/expose-as-mcp/',
  '/changelog/',
  '/blog/',
  '/blog/ai-agents-are-still-single-player/',
  '/cheat-sheet/',
]
const ALL_PATHS = readFileSync('baseline/urls-pages.txt', 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)

const MEASURE = () => {
  const vw = document.documentElement.clientWidth
  const out: string[] = []
  for (const el of Array.from(document.querySelectorAll('*'))) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    if (r.right <= vw + 1 && r.left >= -1) continue
    let clipped = false
    let p = el.parentElement
    while (p && p !== document.documentElement) {
      if (getComputedStyle(p).overflowX !== 'visible') {
        clipped = true
        break
      }
      p = p.parentElement
    }
    if (clipped) continue
    const pr = el.parentElement?.getBoundingClientRect()
    if (pr && pr.right > vw + 1) continue
    out.push(
      `<${el.tagName.toLowerCase()} class="${String((el as HTMLElement).className).slice(0, 70)}"> "${(el.textContent ?? '').slice(0, 40)}"`,
    )
  }
  return { sw: document.documentElement.scrollWidth, cw: vw, out }
}

test('key pages across widths', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    ignoreDefaultArgs: ['--hide-scrollbars'],
  })
  const page = await (await browser.newContext()).newPage()
  const failures: string[] = []
  for (const path of KEY_PATHS) {
    const line: string[] = []
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`${BASE}${path}`, { waitUntil: 'load' })
      await page.waitForTimeout(300)
      const r = await page.evaluate(MEASURE)
      line.push(`${width}:${r.sw <= r.cw ? 'ok' : `SW${r.sw}/CW${r.cw}`}`)
      if (r.sw > r.cw) failures.push(`${path} @${width} ${r.out.join(', ')}`)
    }
    console.log(`${path.padEnd(45)} ${line.join('  ')}`)
  }
  await browser.close()
  console.log(failures.length ? `FAILURES\n${failures.join('\n')}` : 'NO OVERFLOW')
  expect(failures).toEqual([])
})

test('every page at 375', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    ignoreDefaultArgs: ['--hide-scrollbars'],
  })
  const page = await (await browser.newContext()).newPage()
  await page.setViewportSize({ width: 375, height: 900 })
  const failures: string[] = []
  for (const path of ALL_PATHS) {
    const res = await page.goto(`${BASE}${path}`, { waitUntil: 'load' })
    if (!res || res.status() >= 400) {
      failures.push(`HTTP${res?.status()} ${path}`)
      continue
    }
    await page.waitForTimeout(120)
    const r = await page.evaluate(MEASURE)
    if (r.sw > r.cw) failures.push(`${path} sw=${r.sw} cw=${r.cw} ${r.out.join(', ')}`)
  }
  await browser.close()
  console.log(
    failures.length
      ? `FAILURES\n${failures.join('\n')}`
      : `NO OVERFLOW across ${ALL_PATHS.length} pages at 375`,
  )
  expect(failures).toEqual([])
})
