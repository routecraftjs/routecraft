import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { BlogCover } from '@/components/BlogCover'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'

const dir = 'node_modules/.cache/routecraft-og/fonts/'
const f = (n: string) => readFileSync(dir + n)
const svg = await satori(
  createElement(BlogCover, {
    title: 'Stop trusting your LLM to behave. Enforce it.',
    slug: 'stop-trusting-your-llm-to-behave',
    tags: ['ai-agents', 'security', 'guardrails', 'llm'],
    subtitle: 'System prompts are requests, not rules.',
    diagram: 'hands-not-keys',
    figureNumber: 3,
  }),
  {
    width: 1200,
    height: 630,
    fonts: [
      {
        name: 'Fraunces',
        data: f('fraunces_latest_latin-400-normal.ttf'),
        style: 'normal',
        weight: 400,
      },
      {
        name: 'Fraunces',
        data: f('fraunces_latest_latin-700-normal.ttf'),
        style: 'normal',
        weight: 700,
      },
      {
        name: 'Fraunces',
        data: f('fraunces_latest_latin-400-italic.ttf'),
        style: 'italic',
        weight: 400,
      },
      {
        name: 'JetBrains Mono',
        data: f('jetbrains-mono_latest_latin-400-normal.ttf'),
        style: 'normal',
        weight: 400,
      },
    ],
  },
)
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } })
  .render()
  .asPng()
require('node:fs').writeFileSync(
  '/tmp/claude-0/-home-user/20aa9d2f-1fc2-5f42-8932-9a9dc963e917/scratchpad/probe.png',
  png,
)
console.log('ok', svg.length, png.byteLength)
