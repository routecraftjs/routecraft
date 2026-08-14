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

  test('next-channel content never links back to the released channel', async ({
    page,
  }) => {
    // The prose links resolve through the MDX provider, but a component that
    // renders its own href does not unless it asks for the channel: the
    // QuickLink cards on this page sent readers back to /docs/ from /docs/next.
    await page.goto('/docs/next/introduction/')

    const escaped = await page
      .locator('article a[href^="/docs/"]')
      .evaluateAll((nodes) =>
        nodes
          .map((node) => node.getAttribute('href') ?? '')
          .filter((href) => !href.startsWith('/docs/next/')),
      )

    expect(escaped, 'content links that left the next channel').toEqual([])
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

test.describe('explicit anchors', () => {
  test('a paragraph marked with an id publishes it', async ({ page }) => {
    // Markdoc let any block carry `{#id}`. The mail reference points at three
    // paragraphs that way, and unhandled the marker rendered as literal text
    // while the anchors it named did not exist.
    await page.goto('/docs/reference/adapters/mail/')

    for (const id of [
      'mailbody-source-exchange-body',
      'source-headers',
      'send-receipt-headers',
    ]) {
      await expect(page.locator(`#${id}`)).toHaveCount(1)
    }

    expect(await page.locator('article').innerText()).not.toContain('{#')
  })
})

test.describe('heading ids', () => {
  test('every heading carries a usable, unique id', async ({ page }) => {
    // A heading whose content is entirely a link and a component contributed no
    // direct text, so the changelog published seven `id=""` headings: invalid
    // duplicates, and no release was linkable.
    for (const route of ['/changelog/', '/docs/reference/errors/']) {
      await page.goto(route)
      const ids = await page
        .locator('article :is(h1, h2, h3, h4)[id]')
        .evaluateAll((nodes) => nodes.map((node) => node.id))

      expect(
        ids.filter((id) => id === ''),
        `empty ids on ${route}`,
      ).toEqual([])
      expect(
        ids.filter((id, index) => ids.indexOf(id) !== index),
        `duplicate ids on ${route}`,
      ).toEqual([])
    }
  })
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
    // The index is assembled in the browser on first open, so this is slower
    // than a navigation and gets flaky when the workers all land at once.
    test.slow()
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

test.describe('content rendering', () => {
  test('reference tables render as tables', async ({ page }) => {
    await page.goto('/docs/reference/adapters/cosine/')
    // MDX does not parse GitHub Flavored Markdown by default, and losing it
    // turned every options table into paragraphs of pipes.
    expect(await page.locator('table').count()).toBeGreaterThan(0)
    await expect(page.locator('table th').first()).toBeVisible()
  })

  test('tabbed code blocks render their source', async ({ page }) => {
    await page.goto('/docs/introduction/installation/')

    const tabs = page.getByRole('tab')
    expect(await tabs.count()).toBeGreaterThan(1)

    // CodeTabs reads props off its children instead of rendering them, so the
    // MDX component map never gets to unwrap the fence and the raw element
    // reached the panel as "[object Object]".
    async function assertPanelsHoldSource() {
      for (const panel of await page.getByRole('tabpanel').all()) {
        const text = (await panel.innerText()).trim()
        expect(text).not.toContain('[object Object]')
        expect(text.length).toBeGreaterThan(5)
      }
    }

    await assertPanelsHoldSource()
    // A second tab proves the panels are per-tab rather than one shared fence.
    await tabs.nth(1).click()
    await assertPanelsHoldSource()
  })

  test('the blog index keeps its header and featured posts', async ({
    page,
  }) => {
    await page.goto('/blog/')
    await expect(page.locator('h1')).toBeVisible()
    await expect(
      page.getByText('Featured', { exact: true }).first(),
    ).toBeVisible()
  })

  test('a docs page advertises its title, not its slug', async ({ page }) => {
    // The metadata used to be read from the content tree through `process.cwd()`
    // inside `head()`. That failed in two places at once: the deployed image
    // ships no content tree, and the same code runs in the browser, where it
    // fell back to the raw route the moment the page hydrated. The title is
    // therefore read on both sides of hydration, not just off the served HTML.
    test.slow()
    await page.goto('/docs/reference/adapters/mail/', {
      waitUntil: 'domcontentloaded',
    })
    const served = await page.title()

    await page.waitForLoadState('networkidle')
    expect(await page.title(), 'title changed once the page hydrated').toBe(
      served,
    )
    expect(served).toBe('mail · Docs - Routecraft')

    // A reference page opens with a signature fence, and a description drawn
    // from inside it published the signature as the page's social card.
    const description = await page
      .locator('meta[name="description"]')
      .getAttribute('content')
    expect(description).toContain('Read email via IMAP')
  })

  test('a client navigation sets the destination title', async ({ page }) => {
    // `head()` runs in the browser here, with no server to fall back on.
    await page.goto('/docs/introduction/')
    await page.waitForLoadState('networkidle')

    await page.locator('nav a[href="/docs/reference/errors/"]').first().click()
    await expect(page).toHaveTitle('Errors · Docs - Routecraft')
  })

  test('every route sets its own title', async ({ page }) => {
    test.slow()
    for (const route of ['/blog/', '/changelog/', '/cheat-sheet/']) {
      await page.goto(route)
      const title = await page.title()
      expect(title, `${route} inherited the root title`).not.toBe(
        'Routecraft - AI Automation as Code',
      )
    }
  })
})

test.describe('responsive layout', () => {
  for (const width of [375, 414, 768, 1024]) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      test.slow()
      await page.setViewportSize({ width, height: 900 })

      for (const route of [
        '/docs/introduction/',
        '/docs/reference/adapters/cosine/',
        '/blog/',
      ]) {
        await page.goto(route)
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        )
        expect(
          overflow,
          `${route} overflows at ${width}px`,
        ).toBeLessThanOrEqual(1)
      }
    })
  }
})

test.describe('runtime health', () => {
  test('no console errors, page errors or failed requests', async ({
    page,
  }) => {
    test.slow()
    const problems: string[] = []

    page.on('pageerror', (error) =>
      problems.push(`pageerror on ${page.url()}: ${error.message}`),
    )
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        problems.push(`${message.type()} on ${page.url()}: ${message.text()}`)
      }
    })
    page.on('requestfailed', (request) =>
      problems.push(
        `request failed ${request.url()}: ${request.failure()?.errorText}`,
      ),
    )

    // One page of every shape: a hydration mismatch shows up per template, and
    // the blog post template shipped one that the docs pages did not.
    for (const route of [
      '/',
      '/docs/introduction/',
      '/docs/reference/adapters/cosine/',
      '/docs/next/introduction/',
      '/blog/',
      '/blog/your-first-mcp-server-in-typescript/',
      '/changelog/',
      '/cheat-sheet/',
    ]) {
      await page.goto(route)
      await page.waitForLoadState('networkidle')
    }

    expect(problems).toEqual([])
  })
})

test.describe('client-side navigation', () => {
  test('moving between docs pages does not throw', async ({ page }) => {
    test.slow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))

    await page.goto('/docs/introduction/')
    await page.waitForLoadState('networkidle')

    // A client navigation runs the route loader and mounts the outline before
    // the target page's module lands, which a direct load never does. The
    // outline used to measure headings that were not in the document yet and
    // took the whole route down with it.
    for (const href of [
      '/docs/reference/errors/',
      '/docs/advanced/plugins/',
      '/docs/introduction/adapters/',
    ]) {
      await page.locator(`nav a[href="${href}"]`).first().click()
      await page.waitForTimeout(1_500)
      expect(
        await page.getByText('Something went wrong').count(),
        `error boundary after navigating to ${href}`,
      ).toBe(0)
    }

    expect(errors).toEqual([])
  })
})

test.describe('not found', () => {
  // Every miss answers 404 and renders the page, rather than a 200 carrying a
  // bare paragraph that lets the docs sidebar redistribute around it.
  for (const route of [
    '/docs/reference/nope/',
    '/docs/next/reference/nope/',
    '/blog/nope/',
    '/nonsense/',
  ]) {
    test(`${route} answers 404 and renders the page`, async ({
      page,
      request,
    }) => {
      expect((await request.get(route)).status(), route).toBe(404)

      await page.goto(route)
      await expect(
        page.getByRole('heading', { name: 'Page not found' }),
      ).toBeVisible()
      await expect(
        page.getByRole('link', { name: /go back home/i }),
      ).toBeVisible()
    })
  }
})

test.describe('sitemap', () => {
  test('never advertises the next channel', async ({ request }) => {
    const body = await (await request.get('/sitemap.xml')).text()
    expect(body).not.toContain('/docs/next')
    expect(body).not.toContain('/raw/docs-next.md')
  })
})
