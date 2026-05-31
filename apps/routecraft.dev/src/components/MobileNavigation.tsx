'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Dialog, DialogPanel } from '@headlessui/react'

import { Logo } from '@/components/Logo'
import { Navigation } from '@/components/Navigation'
import { topNavLinks } from '@/components/TopNav'

function MenuIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="2"
      strokeLinecap="round"
      {...props}
    >
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  )
}

function CloseIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="2"
      strokeLinecap="round"
      {...props}
    >
      <path d="M5 5l14 14M19 5l-14 14" />
    </svg>
  )
}

function CloseOnNavigation({ close }: { close: () => void }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  useEffect(() => {
    close()
  }, [pathname, searchParams, close])

  return null
}

export function MobileNavigation() {
  const [isOpen, setIsOpen] = useState(false)
  const close = useCallback(() => setIsOpen(false), [setIsOpen])

  function onLinkClick(event: React.MouseEvent<HTMLAnchorElement>) {
    const link = event.currentTarget
    if (
      link.pathname + link.search + link.hash ===
      window.location.pathname + window.location.search + window.location.hash
    ) {
      close()
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="relative"
        aria-label="Open navigation"
      >
        <MenuIcon className="h-6 w-6 stroke-ink/70 transition hover:stroke-cobalt-500" />
      </button>
      <Suspense fallback={null}>
        <CloseOnNavigation close={close} />
      </Suspense>
      <Dialog
        open={isOpen}
        onClose={() => close()}
        className="fixed inset-0 z-50 flex items-start overflow-y-auto bg-ink/40 pr-10 backdrop-blur-sm lg:hidden"
        aria-label="Navigation"
      >
        <DialogPanel className="min-h-full w-full max-w-xs border-r border-ink/15 bg-paper px-5 pt-5 pb-12 sm:px-6">
          <div className="flex items-center justify-between">
            <Link
              href="/"
              className="group flex items-baseline gap-2.5"
              aria-label="Home page"
            >
              <Logo className="h-6 w-6 shrink-0 text-ink" />
              <span
                className="font-editorial text-[1.35rem] leading-none tracking-[-0.02em] text-ink"
                style={{ fontVariationSettings: '"opsz" 48, "SOFT" 30' }}
              >
                Routecraft
              </span>
            </Link>
            <button
              type="button"
              onClick={() => close()}
              aria-label="Close navigation"
              className="group"
            >
              <CloseIcon className="h-5 w-5 stroke-ink/70 transition group-hover:stroke-cobalt-500" />
            </button>
          </div>
          <nav className="mt-10">
            <ul role="list" className="space-y-4">
              {topNavLinks.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    onClick={onLinkClick}
                    className="font-mono text-[0.75rem] tracking-[0.22em] text-ink/70 uppercase transition hover:text-cobalt-500"
                  >
                    {link.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <Navigation className="mt-10" onLinkClick={onLinkClick} />
        </DialogPanel>
      </Dialog>
    </>
  )
}
