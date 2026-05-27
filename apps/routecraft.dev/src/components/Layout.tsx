'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'

import { Footer } from '@/components/Footer'
import { MobileNavigation } from '@/components/MobileNavigation'
import { Navigation } from '@/components/Navigation'
import { Search } from '@/components/Search'
import { ThemeSelector } from '@/components/ThemeSelector'
import { TopNav } from '@/components/TopNav'
import { VersionSelector } from '@/components/VersionSelector'

function GitHubIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" {...props}>
      <path d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z" />
    </svg>
  )
}

function Header() {
  const [isScrolled, setIsScrolled] = useState(false)

  useEffect(() => {
    function onScroll() {
      setIsScrolled(window.scrollY > 0)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
    }
  }, [])

  return (
    <header
      className={clsx(
        'sticky top-0 z-50 flex flex-none flex-wrap items-center justify-between border-b border-ink/15 bg-paper px-4 py-4 transition duration-500 sm:px-6 lg:px-8 dark:border-paper/15 dark:bg-ink',
        isScrolled &&
          'bg-paper/85 backdrop-blur-sm dark:bg-ink/85 [@supports(backdrop-filter:blur(0))]:bg-paper/70 dark:[@supports(backdrop-filter:blur(0))]:bg-ink/70',
      )}
    >
      <div className="mr-6 flex lg:hidden">
        <MobileNavigation />
      </div>
      <div className="relative flex grow basis-0 items-center gap-10">
        <Link
          href="/"
          aria-label="Home page"
          className="group flex items-baseline gap-2.5"
        >
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 shrink-0 translate-y-[-0.15em] bg-cobalt-500 transition group-hover:scale-110"
          />
          <span
            className="font-editorial text-[1.35rem] leading-none tracking-[-0.02em] text-ink dark:text-paper"
            style={{ fontVariationSettings: '"opsz" 48, "SOFT" 30' }}
          >
            Routecraft
          </span>
        </Link>
        <VersionSelector className="hidden lg:block" />
        <TopNav />
      </div>
      <div className="flex items-center gap-4 sm:gap-5">
        <div className="-my-5">
          <Search />
        </div>
        <ThemeSelector className="relative z-10" />
        <Link
          href="https://github.com/routecraftjs/routecraft"
          className="group"
          aria-label="GitHub"
        >
          <GitHubIcon className="h-5 w-5 fill-ink/55 transition group-hover:fill-cobalt-500 dark:fill-paper/55 dark:group-hover:fill-cobalt-300" />
        </Link>
      </div>
    </header>
  )
}

export function Layout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isHomePage = pathname === '/'
  const isBlogSection = pathname?.startsWith('/blog') ?? false
  const isBlogLanding = pathname === '/blog' || pathname === '/blog/'
  const isCheatSheet = pathname?.startsWith('/cheat-sheet') ?? false
  const showDocsSidebar = !isHomePage && !isBlogSection && !isCheatSheet
  const useFullWidth = isHomePage || isCheatSheet
  // Footer only on marketing-style pages. Docs and blog detail pages have
  // their own scroll behavior (docs sidebar scrolls separately, blog posts
  // have a per-post footer) and a global footer there overflows weirdly.
  const showFooter = isHomePage || isCheatSheet || isBlogLanding

  return (
    <div className="flex min-h-full w-full flex-col">
      <Header />

      <div
        className={
          useFullWidth
            ? 'relative flex w-full flex-auto flex-col'
            : 'relative mx-auto flex w-full max-w-8xl flex-auto justify-center sm:px-2 lg:px-8 xl:px-12'
        }
      >
        {showDocsSidebar && (
          <div className="hidden lg:relative lg:block lg:flex-none">
            <div className="absolute inset-y-0 right-0 hidden w-px bg-ink/15 lg:block dark:bg-paper/15" />
            <div className="sticky top-19 -ml-0.5 h-[calc(100vh-4.75rem)] w-64 overflow-x-hidden overflow-y-auto py-16 pr-8 pl-0.5 xl:w-72 xl:pr-16">
              <Navigation />
            </div>
          </div>
        )}
        {children}
      </div>

      {showFooter && <Footer />}
    </div>
  )
}
