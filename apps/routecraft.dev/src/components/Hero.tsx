'use client'
import { Fragment, useState } from 'react'
import Image from 'next/image'
import clsx from 'clsx'
import { Highlight } from 'prism-react-renderer'

import { Button } from '@/components/Button'
import { HeroBackground } from '@/components/HeroBackground'
import blurCyanImage from '@/images/blur-cyan.png'
import blurIndigoImage from '@/images/blur-indigo.png'

const codeLanguage = 'typescript'
const aiToolExample = `import { mcp } from '@routecraft/ai'
import { craft, mail } from '@routecraft/routecraft'
import { z } from 'zod'

export default craft()
  .id('send-team-email')
  .from(mcp('send-team-email', {
    description: 'Send email to team members',
    schema: z.object({
      to: z.string().email(),
      subject: z.string(),
      message: z.string()
    })
  }))
  // Guardrail: Only allow emails to company domain
  .filter(({ to }) => to.endsWith('@company.com'))
  .to(mail())`

const mcpConfigExample = `{
  "mcpServers": {
    "routecraft": {
      "command": "npx",
      "args": [
        "@routecraft/cli",
        "run",
        "--log-file",
        "/path/to/craft.log",
        "--log-level",
        "debug",
        "/path/to/routecraft/index.ts"
      ]
    }
  }
}`

type CodeTab = { name: string; code: string }
const tabs: CodeTab[] = [
  { name: 'capabilities/send-email.ts', code: aiToolExample },
  { name: 'claude_desktop_config.json', code: mcpConfigExample },
]

function TrafficLightsIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 42 10" fill="none" {...props}>
      <circle cx="5" cy="5" r="4.5" />
      <circle cx="21" cy="5" r="4.5" />
      <circle cx="37" cy="5" r="4.5" />
    </svg>
  )
}

export function Hero() {
  const [activeTab, setActiveTab] = useState<string>(
    'capabilities/send-email.ts',
  )
  const active = tabs.find((t) => t.name === activeTab) ?? tabs[0]
  const code = active.code
  return (
    <div className="overflow-hidden bg-gray-50 dark:-mt-19 dark:-mb-32 dark:bg-gray-950 dark:pt-19 dark:pb-32">
      <div className="py-16 sm:px-2 lg:relative lg:px-0 lg:py-20">
        <div className="mx-auto grid max-w-2xl grid-cols-1 items-center gap-x-8 gap-y-16 px-4 lg:max-w-8xl lg:grid-cols-2 lg:px-8 xl:gap-x-16 xl:px-12">
          <div className="relative z-10 md:text-center lg:text-left">
            <Image
              className="absolute right-full bottom-full -mr-72 -mb-56 opacity-20 dark:opacity-50"
              src={blurCyanImage}
              alt=""
              width={530}
              height={530}
              unoptimized
              priority
            />
            <div className="relative">
              <p className="inline bg-linear-to-r from-indigo-600 via-sky-500 to-indigo-600 bg-clip-text font-display text-5xl tracking-tight text-transparent dark:from-indigo-200 dark:via-sky-400 dark:to-indigo-200">
                Give AI access, not control
              </p>
              <p className="mt-3 text-2xl tracking-tight text-gray-600 dark:text-gray-400">
                Define TypeScript capabilities that send emails, manage
                calendars, and automate work. Expose them to the Routcraft
                agent, Claude, ChatGPT, Cursor, or any AI agent via MCP. AI
                calls your code, not your computer.
              </p>
              <div className="mt-8 flex gap-4 md:justify-center lg:justify-start">
                <Button href="https://github.com/routecraftjs/routecraft">
                  Star on GitHub
                </Button>
                <Button href="/docs/introduction" variant="secondary">
                  Get started
                </Button>
              </div>
            </div>
          </div>
          <div className="relative lg:static xl:pl-10">
            <div className="absolute inset-x-[-50vw] -top-32 -bottom-48 mask-[linear-gradient(transparent,white,white)] opacity-30 lg:-top-32 lg:right-0 lg:-bottom-32 lg:left-[calc(50%+14rem)] lg:mask-none dark:mask-[linear-gradient(transparent,white,transparent)] dark:opacity-100 lg:dark:mask-[linear-gradient(white,white,transparent)]">
              <HeroBackground className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 lg:left-0 lg:translate-x-0 lg:translate-y-[-60%]" />
            </div>
            <div className="relative">
              <Image
                className="absolute -top-64 -right-64 opacity-30 dark:opacity-100"
                src={blurCyanImage}
                alt=""
                width={530}
                height={530}
                unoptimized
                priority
              />
              <Image
                className="absolute -right-44 -bottom-40 opacity-30 dark:opacity-100"
                src={blurIndigoImage}
                alt=""
                width={567}
                height={567}
                unoptimized
                priority
              />
              <div className="absolute inset-0 rounded-2xl bg-linear-to-tr from-sky-300 via-sky-300/70 to-blue-300 opacity-5 blur-lg dark:opacity-10" />
              <div className="absolute inset-0 rounded-2xl bg-linear-to-tr from-sky-300 via-sky-300/70 to-blue-300 opacity-5 dark:opacity-10" />
              <div className="relative rounded-2xl bg-white/80 ring-1 ring-gray-200 backdrop-blur-sm dark:bg-[#0A101F]/60 dark:ring-white/10">
                <div className="absolute -top-px right-11 left-20 h-px bg-linear-to-r from-sky-300/0 via-sky-300/40 to-sky-300/0 dark:via-sky-300/70" />
                <div className="absolute right-20 -bottom-px left-11 h-px bg-linear-to-r from-blue-400/0 via-blue-400/50 to-blue-400/0 dark:via-blue-400" />
                <div className="pt-4 pl-4">
                  <TrafficLightsIcon className="h-2.5 w-auto stroke-gray-400/50 dark:stroke-gray-500/30" />
                  <div className="mt-4 flex space-x-2 text-xs">
                    {tabs.map((tab) => {
                      const isActive = activeTab === tab.name
                      const isDisabled = !tab.code
                      return (
                        <button
                          key={tab.name}
                          onClick={() => {
                            if (!isDisabled) setActiveTab(tab.name)
                          }}
                          disabled={isDisabled}
                          className={clsx(
                            'flex h-6 rounded-full',
                            isActive
                              ? 'bg-linear-to-r from-sky-500/30 via-sky-500 to-sky-500/30 p-px font-medium text-sky-600 dark:from-sky-400/30 dark:via-sky-400 dark:to-sky-400/30 dark:text-sky-300'
                              : 'text-gray-400 dark:text-gray-500',
                            isDisabled && 'cursor-not-allowed opacity-50',
                          )}
                        >
                          <span
                            className={clsx(
                              'flex items-center rounded-full px-2.5',
                              isActive && 'bg-white dark:bg-gray-800',
                            )}
                          >
                            {tab.name}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  <div className="mt-6 flex items-start px-1 text-sm">
                    <div
                      aria-hidden="true"
                      className="border-r border-gray-200 pr-4 font-mono text-gray-400 select-none dark:border-gray-300/5 dark:text-gray-600"
                    >
                      {Array.from({
                        length: code.split('\n').length,
                      }).map((_, index) => (
                        <Fragment key={index}>
                          {(index + 1).toString().padStart(2, '0')}
                          <br />
                        </Fragment>
                      ))}
                    </div>
                    <Highlight
                      code={code}
                      language={codeLanguage}
                      theme={{ plain: {}, styles: [] }}
                    >
                      {({
                        className,
                        style,
                        tokens,
                        getLineProps,
                        getTokenProps,
                      }) => (
                        <pre
                          className={clsx(
                            className,
                            'flex overflow-x-auto pb-6',
                          )}
                          style={style}
                        >
                          <code className="px-4">
                            {tokens.map((line, lineIndex) => (
                              <div key={lineIndex} {...getLineProps({ line })}>
                                {line.map((token, tokenIndex) => (
                                  <span
                                    key={tokenIndex}
                                    {...getTokenProps({ token })}
                                  />
                                ))}
                              </div>
                            ))}
                          </code>
                        </pre>
                      )}
                    </Highlight>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
