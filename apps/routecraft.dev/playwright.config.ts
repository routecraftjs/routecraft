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

/**
 * The suite only owns the server when it is testing this machine's own build.
 * Pointed at production or at a running container it must attach to what is
 * already there, and starting a local server would silently test the wrong
 * thing while the real target went unvisited.
 */
const servesItsOwnBuild = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(
  baseURL,
)

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
  ...(servesItsOwnBuild
    ? {
        webServer: {
          command: 'bun run start',
          // The server listens on 3000 unless told otherwise, so a BASE_URL
          // naming another port would leave Playwright waiting on a port
          // nothing was ever going to answer on.
          env: { PORT: new URL(baseURL).port || '3000' },
          url: baseURL,
          // Locally this attaches to a server already in front of you; on a
          // runner there is nothing legitimate to attach to, and reusing would
          // mean testing whatever a previous step left behind.
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      }
    : {}),
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
