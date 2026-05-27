'use client'

import { Children, isValidElement } from 'react'
import { Tab } from '@headlessui/react'
import clsx from 'clsx'
import { Fence } from '@/components/Fence'

export function CodeTabs({ children }: { children: React.ReactNode }) {
  const tabs = Children.toArray(children).filter(isValidElement) as Array<
    React.ReactElement<{ label: string; language: string; children: string }>
  >

  return (
    <Tab.Group>
      <div className="relative">
        <Tab.List className="absolute top-2.5 left-3 z-10 flex gap-px bg-ink/15 dark:bg-paper/15">
          {tabs.map((tab, index) => (
            <Tab
              key={tab.props.label ?? index}
              className={({ selected }) =>
                clsx(
                  'px-3 py-1 font-mono text-[0.65rem] tracking-[0.18em] uppercase transition focus:outline-none',
                  selected
                    ? 'bg-cobalt-500 text-paper'
                    : 'bg-paper-deep text-ink/55 hover:text-cobalt-500 dark:bg-ink-soft dark:text-paper/55 dark:hover:text-cobalt-300',
                )
              }
            >
              {tab.props.label}
            </Tab>
          ))}
        </Tab.List>
        <Tab.Panels>
          {tabs.map((tab, index) => (
            <Tab.Panel
              key={tab.props.label ?? index}
              className="focus:outline-none"
            >
              <Fence language={tab.props.language} offsetTop>
                {String(tab.props.children)}
              </Fence>
            </Tab.Panel>
          ))}
        </Tab.Panels>
      </div>
    </Tab.Group>
  )
}

export function CodeTab({
  children,
}: {
  label: string
  language: string
  children: string
}) {
  // This component is only a marker for CodeTabs to read props from.
  // It doesn't render anything by itself.
  return <>{children}</>
}
