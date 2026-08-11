# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: acceptance.spec.ts >> site shell >> search opens and returns a result
- Location: tests/acceptance.spec.ts:158:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('[role="dialog"] a[href*="/docs/"]').first()
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 15000ms
  - waiting for locator('[role="dialog"] a[href*="/docs/"]').first()

```

```yaml
- dialog:
  - combobox [expanded]:
    - search:
      - searchbox "Find something...": adapter
      - listbox:
        - option "Introduction / Adapters" [selected]
        - option "Introduction/Events / Adapter metadata in operation events"
        - option "Introduction/The Exchange / Adapter-specific headers"
        - option "Introduction/Introduction / Adapters"
        - option "Migrating from 0.4.x to 0.5.0 / Adapter mocking"
```

# Test source

```ts
  66  |     await expect(page.locator('h1')).toBeVisible()
  67  |   })
  68  | 
  69  |   test('the next channel serves in-development content', async ({ page }) => {
  70  |     await page.goto('/docs/next/introduction/')
  71  |     await expect(page.locator('h1')).toBeVisible()
  72  |   })
  73  | 
  74  |   test('a released page never links into the next channel', async ({
  75  |     page,
  76  |   }) => {
  77  |     await page.goto('/docs/reference/errors/')
  78  |     const leaked = await page.locator('a[href^="/docs/next/"]').count()
  79  |     expect(leaked, 'links leaking from the released channel').toBe(0)
  80  |   })
  81  | 
  82  |   test('a next-channel page keeps its links on the next channel', async ({
  83  |     page,
  84  |   }) => {
  85  |     await page.goto('/docs/next/reference/errors/')
  86  |     const onChannel = await page.locator('a[href^="/docs/next/"]').count()
  87  |     expect(onChannel).toBeGreaterThan(0)
  88  |   })
  89  | 
  90  |   test('the next channel is not indexed', async ({ page }) => {
  91  |     await page.goto('/docs/next/introduction/')
  92  |     const robots = page.locator('meta[name="robots"]')
  93  |     await expect(robots).toHaveAttribute('content', /noindex/)
  94  |   })
  95  | })
  96  | 
  97  | test.describe('heading anchors', () => {
  98  |   const anchorBaseline = baselineLines('anchors.txt').reduce<
  99  |     Map<string, string[]>
  100 |   >((pages, line) => {
  101 |     const [url, id] = line.split(' ')
  102 |     if (!id) return pages
  103 |     pages.set(url, [...(pages.get(url) ?? []), id])
  104 |     return pages
  105 |   }, new Map())
  106 | 
  107 |   for (const route of ['/docs/reference/errors/', '/docs/reference/events/']) {
  108 |     test(`anchors on ${route} are unchanged`, async ({ page }) => {
  109 |       await page.goto(route)
  110 | 
  111 |       const rendered = new Set(
  112 |         await page.locator('h1[id], h2[id], h3[id], h4[id]').evaluateAll(
  113 |           (nodes) => nodes.map((node) => node.id),
  114 |         ),
  115 |       )
  116 | 
  117 |       // Layout ids are not content and were never part of the contract.
  118 |       const expected = (anchorBaseline.get(route) ?? []).filter(
  119 |         (id) => id !== '' && id !== 'on-this-page-title',
  120 |       )
  121 | 
  122 |       expect(expected.length, 'baseline captured no anchors').toBeGreaterThan(0)
  123 |       expect(
  124 |         expected.filter((id) => !rendered.has(id)),
  125 |         'anchors that disappeared',
  126 |       ).toEqual([])
  127 |     })
  128 |   }
  129 | })
  130 | 
  131 | test.describe('code rendering', () => {
  132 |   test('fenced code keeps its source', async ({ page }) => {
  133 |     await page.goto('/docs/advanced/plugins/')
  134 |     const first = page.locator('pre').first()
  135 |     await expect(first).toBeVisible()
  136 |     expect((await first.innerText()).trim().length).toBeGreaterThan(20)
  137 |   })
  138 | })
  139 | 
  140 | test.describe('site shell', () => {
  141 |   test('the home page renders', async ({ page }) => {
  142 |     await page.goto('/')
  143 |     await expect(page.locator('h1').first()).toBeVisible()
  144 |   })
  145 | 
  146 |   test('the blog index lists posts', async ({ page }) => {
  147 |     await page.goto('/blog/')
  148 |     expect(await page.locator('a[href^="/blog/"]').count()).toBeGreaterThan(0)
  149 |   })
  150 | 
  151 |   test('the changelog and cheat sheet render', async ({ page }) => {
  152 |     for (const route of ['/changelog/', '/cheat-sheet/']) {
  153 |       await page.goto(route)
  154 |       await expect(page.locator('h1').first()).toBeVisible()
  155 |     }
  156 |   })
  157 | 
  158 |   test('search opens and returns a result', async ({ page }) => {
  159 |     await page.goto('/docs/introduction/')
  160 |     await page.getByRole('button', { name: /search/i }).first().click()
  161 |     const input = page.locator('[role="dialog"] input').first()
  162 |     await input.waitFor({ state: 'visible' })
  163 |     await input.fill('adapter')
  164 |     await expect(
  165 |       page.locator('[role="dialog"] a[href*="/docs/"]').first(),
> 166 |     ).toBeVisible({ timeout: 15_000 })
      |       ^ Error: expect(locator).toBeVisible() failed
  167 |   })
  168 | })
  169 | 
  170 | test.describe('sitemap', () => {
  171 |   test('never advertises the next channel', async ({ request }) => {
  172 |     const body = await (await request.get('/sitemap.xml')).text()
  173 |     expect(body).not.toContain('/docs/next')
  174 |     expect(body).not.toContain('/raw/docs-next.md')
  175 |   })
  176 | })
  177 | 
```