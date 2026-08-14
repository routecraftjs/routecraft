import { Children, isValidElement } from 'react'
import type { ReactNode } from 'react'
import { Tab } from '@headlessui/react'
import clsx from 'clsx'
import { Fence } from '@/components/Fence'
import { readCodeSource } from '@/lib/code-source'

interface CodeTabProps {
  label: string
  language?: string
  children?: ReactNode
}

/**
 * A fenced code block per language, behind a tab strip.
 *
 * The tabs are read as props off the `CodeTab` children rather than rendered,
 * so `CodeTab` itself never runs and the fence has to be unwrapped here.
 */
export function CodeTabs({ children }: { children: ReactNode }) {
  const tabs = Children.toArray(children)
    .filter(isValidElement)
    .map((tab, index) => {
      const props = (tab as React.ReactElement<CodeTabProps>).props
      const source = readCodeSource(props.children)

      return {
        key: props.label ?? index,
        label: props.label,
        language: props.language ?? source.language,
        code: source.code,
      }
    })

  return (
    <Tab.Group>
      <div className="relative">
        <Tab.List className="absolute top-2.5 left-3 z-10 flex gap-px bg-ink/15">
          {tabs.map((tab) => (
            <Tab
              key={tab.key}
              className={({ selected }) =>
                clsx(
                  'px-3 py-1 font-mono text-[0.65rem] tracking-[0.18em] uppercase transition focus:outline-none',
                  selected
                    ? 'bg-cobalt-500 text-paper'
                    : 'bg-paper-deep text-ink/55 hover:text-cobalt-500',
                )
              }
            >
              {tab.label}
            </Tab>
          ))}
        </Tab.List>
        <Tab.Panels>
          {tabs.map((tab) => (
            <Tab.Panel key={tab.key} className="focus:outline-none">
              <Fence language={tab.language} offsetTop>
                {tab.code}
              </Fence>
            </Tab.Panel>
          ))}
        </Tab.Panels>
      </div>
    </Tab.Group>
  )
}

/**
 * Marker read by `CodeTabs`, which takes its props and renders the panels
 * itself. It has to exist for MDX to resolve `<CodeTab>`, but it never renders.
 */
export function CodeTab(): null {
  return null
}
