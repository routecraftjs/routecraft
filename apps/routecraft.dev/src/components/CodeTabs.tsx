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
        <Tab.List className="absolute top-2 left-3 z-10 flex gap-2">
          {tabs.map((tab, index) => (
            <Tab
              key={tab.props.label ?? index}
              className={({ selected }) =>
                clsx(
                  'rounded-md px-3 py-1 text-xs font-medium backdrop-blur-sm',
                  selected
                    ? 'bg-slate-700/90 text-white dark:bg-slate-700'
                    : 'bg-slate-800/60 text-slate-300 hover:bg-slate-700/70 dark:bg-slate-800/40',
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
