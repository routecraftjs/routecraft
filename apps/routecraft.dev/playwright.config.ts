import { defineConfig, devices } from '@playwright/test'

/**
 * The acceptance suite runs against a served build, not the dev server.
 *
 * `BASE_URL` points it at whatever is under test: the production site while the
 * assertions are being written, then `docker run` of the release image. The
 * default is the local production server so `bun run test` after a build does
 * the right thing with no arguments.
 */
const baseURL = process.env.BASE_URL ?? 'http://localhost:3000'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Some environments provide a preinstalled browser rather than one
        // downloaded per Playwright version.
        ...(process.env.CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
          : {}),
      },
    },
  ],
})
