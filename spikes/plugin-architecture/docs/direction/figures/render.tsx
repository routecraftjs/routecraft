#!/usr/bin/env bun
/* eslint-disable no-console -- A render script reports what it wrote. */
/**
 * Renders every figure in `index.ts` to a PNG beside it, light and dark, the
 * way the docs site exports its blog figures (`scripts/export-figures.ts`):
 * a fixed canvas laid out by a real browser and screenshotted at 2x.
 *
 * The figures are authored in the site's own vocabulary (`primitives.tsx`,
 * `palette.ts`), so moving one into `apps/routecraft.dev/app/components/figures/`
 * is a copy plus an import path. React and the fonts are the site's, reached
 * through symlinks in `./node_modules` (ignored by git); `bun run render`
 * creates them when absent.
 *
 *   bun docs/direction/figures/render.tsx            # every figure
 *   bun docs/direction/figures/render.tsx four-sockets  # one
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";

import { DRAWINGS, FIGURE_TEXT } from "./index.ts";
import { FIGURE_PALETTE_THEMED } from "./palette.ts";

const here = path.dirname(new URL(import.meta.url).pathname);
const site = path.resolve(
  here,
  "../../../../../apps/routecraft.dev/node_modules",
);
const scratch = process.env["FIGURE_SCRATCH"] ?? path.join(here, ".render");

function link() {
  const nm = path.join(here, "node_modules");
  mkdirSync(path.join(nm, "@types"), { recursive: true });
  for (const [from, to] of [
    ["react", "react"],
    ["react-dom", "react-dom"],
    ["@types/react", "@types/react"],
    ["@fontsource-variable", "@fontsource-variable"],
    ["playwright", "playwright"],
    ["@types/react-dom", "@types/react-dom"],
  ] as const)
    if (!existsSync(path.join(nm, to)))
      symlinkSync(path.join(site, from), path.join(nm, to));
}

/** The site's tokens (`app/styles/tailwind.css`), light and dark. */
const THEMES = {
  light: {
    "--color-paper": "#f5f1e8",
    "--color-paper-deep": "#ebe5da",
    "--color-ink": "#22232c",
    "--color-cobalt-500": "#1247ff",
  },
  dark: {
    "--color-paper": "#1d1e26",
    "--color-paper-deep": "#262832",
    "--color-ink": "#f0ece1",
    "--color-cobalt-500": "#7482ff",
  },
} as const;

function page(
  theme: keyof typeof THEMES,
  body: string,
  width: number,
  height: number,
) {
  const fonts = path.join(site, "@fontsource-variable");
  const vars = Object.entries(THEMES[theme])
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="file://${fonts}/ibm-plex-sans/index.css">
<link rel="stylesheet" href="file://${fonts}/fraunces/full.css">
<link rel="stylesheet" href="file://${fonts}/fraunces/full-italic.css">
<link rel="stylesheet" href="file://${fonts}/jetbrains-mono/index.css">
<style>
:root { ${vars} --font-sans: 'IBM Plex Sans Variable'; --font-editorial: 'Fraunces Variable'; --font-mono: 'JetBrains Mono Variable'; }
html, body { margin: 0; padding: 0; background: var(--color-paper); }
[data-figure-export] { width: ${width}px; height: ${height}px; }
* { box-sizing: border-box; }
</style></head><body><div data-figure-export>${body}</div></body></html>`;
}

async function main() {
  link();
  mkdirSync(scratch, { recursive: true });
  const wanted = new Set(process.argv.slice(2));
  const drawings = DRAWINGS.filter(
    (d) => wanted.size === 0 || wanted.has(d.id),
  );
  for (const d of drawings)
    if (!FIGURE_TEXT[d.id]?.alt?.trim() || !FIGURE_TEXT[d.id]?.caption?.trim())
      throw new Error(
        `index.ts needs a non-empty alt and caption for figure: ${d.id}`,
      );
  // The site pins its own Playwright; this environment ships one Chromium, so launch it by path when the pinned build is absent.
  const browser = await chromium
    .launch()
    .catch(() =>
      chromium.launch({ executablePath: "/opt/pw-browsers/chromium" }),
    );
  try {
    const context = await browser.newContext({ deviceScaleFactor: 2 });
    for (const d of drawings) {
      for (const theme of ["light", "dark"] as const) {
        const html = page(
          theme,
          renderToStaticMarkup(<d.Figure palette={FIGURE_PALETTE_THEMED} />),
          d.width,
          d.height,
        );
        const file = path.join(scratch, `${d.id}-${theme}.html`);
        writeFileSync(file, html);
        const p = await context.newPage();
        await p.setViewportSize({ width: d.width, height: d.height });
        await p.goto(`file://${file}`);
        await p.evaluate(() => document.fonts.ready);
        const out = path.join(
          here,
          `${d.id}${theme === "dark" ? "-dark" : ""}.png`,
        );
        await p.locator("[data-figure-export]").screenshot({ path: out });
        await p.close();
        console.log(`rendered ${path.relative(process.cwd(), out)}`);
      }
    }
  } finally {
    await browser.close();
  }
}

await main();
