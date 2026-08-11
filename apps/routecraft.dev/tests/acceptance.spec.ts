/**
 * The migration's acceptance suite.
 *
 * Every assertion here holds on the production Next.js site as well, which is
 * how the suite was validated: run it with `BASE_URL=https://routecraft.dev`
 * and it must pass before it means anything about the new stack.
 *
 * The URL and anchor baselines it reads were captured from production before
 * the migration began.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

const baselineDir = join(import.meta.dirname, '..', 'baseline')

function baselineLines(file: string): string[] {
  return readFileSync(join(baselineDir, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
}

const pageUrls = baselineLines('urls-pages.txt')
const rawUrls = baselineLines('urls-sitemap.txt').filter((url) =>
  url.startsWith('/raw/'),
)

test.describe('published URL space', () => {
  test('every page captured from production still resolves', async ({
    request,
  }) => {
    const missing: string[] = []

    for (const url of pageUrls) {
      const response = await request.get(url)
      if (response.status() !== 200) missing.push(`${response.status()} ${url}`)
    }

    expect(missing, 'pages that no longer resolve').toEqual([])
  })

  test('every raw mirror captured from production still resolves', async ({
    request,
  }) => {
    const missing: string[] = []

    for (const url of rawUrls) {
      const response = await request.get(url)
      if (response.status() !== 200) missing.push(`${response.status()} ${url}`)
    }

    expect(missing, 'raw mirrors that no longer resolve').toEqual([])
  })

  test('the llms bundles are served', async ({ request }) => {
    for (const url of ['/llms.txt', '/llms-full.txt', '/llms-full-next.txt']) {
      expect((await request.get(url)).status(), url).toBe(200)
    }
  })
})

test.describe('docs channels', () => {
  test('the released channel serves released content', async ({ page }) => {
    await page.goto('/docs/introduction/')
    await expect(page.locator('h1')).toBeVisible()
  })

  test('the next channel serves in-development content', async ({ page }) => {
    await page.goto('/docs/next/introduction/')
    await expect(page.locator('h1')).toBeVisible()
  })

  test('a released page never links into the next channel', async ({
    page,
  }) => {
    await page.goto('/docs/reference/errors/')
    const leaked = await page.locator('a[href^="/docs/next/"]').count()
    expect(leaked, 'links leaking from the released channel').toBe(0)
  })

  test('a next-channel page keeps its links on the next channel', async ({
    page,
  }) => {
    await page.goto('/docs/next/reference/errors/')
    const onChannel = await page.locator('a[href^="/docs/next/"]').count()
    expect(onChannel).toBeGreaterThan(0)
  })

  test('the next channel is not indexed', async ({ page }) => {
    await page.goto('/docs/next/introduction/')
    const robots = page.locator('meta[name="robots"]')
    await expect(robots).toHaveAttribute('content', /noindex/)
  })
})

test.describe('heading anchors', () => {
  const anchorBaseline = baselineLines('anchors.txt').reduce<
    Map<string, string[]>
  >((pages, line) => {
    const [url, id] = line.split(' ')
    if (!id) return pages
    pages.set(url, [...(pages.get(url) ?? []), id])
    return pages
  }, new Map())

  for (const route of ['/docs/reference/errors/', '/docs/reference/events/']) {
    test(`anchors on ${route} are unchanged`, async ({ page }) => {
      await page.goto(route)

      const rendered = new Set(
        await page
          .locator('h1[id], h2[id], h3[id], h4[id]')
          .evaluateAll((nodes) => nodes.map((node) => node.id)),
      )

      // Layout ids are not content and were never part of the contract.
      const expected = (anchorBaseline.get(route) ?? []).filter(
        (id) => id !== '' && id !== 'on-this-page-title',
      )

      expect(expected.length, 'baseline captured no anchors').toBeGreaterThan(0)
      expect(
        expected.filter((id) => !rendered.has(id)),
        'anchors that disappeared',
      ).toEqual([])
    })
  }
})

test.describe('code rendering', () => {
  test('fenced code keeps its source', async ({ page }) => {
    await page.goto('/docs/advanced/plugins/')
    const first = page.locator('pre').first()
    await expect(first).toBeVisible()
    expect((await first.innerText()).trim().length).toBeGreaterThan(20)
  })
})

test.describe('site shell', () => {
  test('the home page renders', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('h1').first()).toBeVisible()
  })

  test('the blog index lists posts', async ({ page }) => {
    await page.goto('/blog/')
    expect(await page.locator('a[href^="/blog/"]').count()).toBeGreaterThan(0)
  })

  test('the changelog and cheat sheet render', async ({ page }) => {
    for (const route of ['/changelog/', '/cheat-sheet/']) {
      await page.goto(route)
      await expect(page.locator('h1').first()).toBeVisible()
    }
  })

  test('search opens and returns a result', async ({ page }) => {
    await page.goto('/docs/introduction/')
    await page
      .getByRole('button', { name: /search/i })
      .first()
      .click()
    const input = page.locator('[role="dialog"] input').first()
    await input.waitFor({ state: 'visible' })
    await input.fill('adapter')
    await expect(
      page.locator('[role="dialog"] a[href*="/docs/"]').first(),
    ).toBeVisible({ timeout: 15_000 })
  })
})

test.describe('sitemap', () => {
  test('never advertises the next channel', async ({ request }) => {
    const body = await (await request.get('/sitemap.xml')).text()
    expect(body).not.toContain('/docs/next')
    expect(body).not.toContain('/raw/docs-next.md')
  })
})
