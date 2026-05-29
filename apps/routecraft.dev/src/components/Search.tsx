'use client'

import {
  forwardRef,
  Fragment,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import Highlighter from 'react-highlight-words'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  type AutocompleteApi,
  type AutocompleteCollection,
  type AutocompleteState,
  createAutocomplete,
} from '@algolia/autocomplete-core'
import { Dialog, DialogPanel } from '@headlessui/react'
import clsx from 'clsx'

import { navigation } from '@/lib/navigation'
import { useClientValue } from '@/lib/use-client-value'
import { type Result } from '@/markdoc/search.mjs'

type EmptyObject = Record<string, never>

type Autocomplete = AutocompleteApi<
  Result,
  React.SyntheticEvent,
  React.MouseEvent,
  React.KeyboardEvent
>

function SearchIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" {...props}>
      <path d="M16.293 17.707a1 1 0 0 0 1.414-1.414l-1.414 1.414ZM9 14a5 5 0 0 1-5-5H2a7 7 0 0 0 7 7v-2ZM4 9a5 5 0 0 1 5-5V2a7 7 0 0 0-7 7h2Zm5-5a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7v2Zm8.707 12.293-3.757-3.757-1.414 1.414 3.757 3.757 1.414-1.414ZM14 9a4.98 4.98 0 0 1-1.464 3.536l1.414 1.414A6.98 6.98 0 0 0 16 9h-2Zm-1.464 3.536A4.98 4.98 0 0 1 9 14v2a6.98 6.98 0 0 0 4.95-2.05l-1.414-1.414Z" />
    </svg>
  )
}

function useAutocomplete({
  close,
}: {
  close: (autocomplete: Autocomplete) => void
}) {
  const id = useId()
  const router = useRouter()
  const [autocompleteState, setAutocompleteState] = useState<
    AutocompleteState<Result> | EmptyObject
  >({})

  const [autocomplete] = useState<Autocomplete>(() => {
    // `navigate` and the autocomplete instance reference each other:
    // `createAutocomplete({ navigator: { navigate } })` captures `navigate`,
    // and `navigate` calls `close(instance)` after a successful navigation.
    // The library only invokes `navigator.navigate` from user-driven event
    // handlers (never during construction), so by the time the closure runs
    // `holder.current` is set. The explicit holder avoids a non-null
    // assertion and makes the ordering assumption visible.
    const holder: { current: Autocomplete | null } = { current: null }

    function navigate({ itemUrl }: { itemUrl?: string }) {
      if (!itemUrl) {
        return
      }

      router.push(itemUrl)

      if (
        itemUrl ===
          window.location.pathname +
            window.location.search +
            window.location.hash &&
        holder.current
      ) {
        close(holder.current)
      }
    }

    holder.current = createAutocomplete<
      Result,
      React.SyntheticEvent,
      React.MouseEvent,
      React.KeyboardEvent
    >({
      id,
      placeholder: 'Find something...',
      defaultActiveItemId: 0,
      onStateChange({ state }) {
        setAutocompleteState(state)
      },
      shouldPanelOpen({ state }) {
        return state.query !== ''
      },
      navigator: {
        navigate,
      },
      getSources({ query }) {
        return import('@/markdoc/search.mjs').then(({ search }) => {
          return [
            {
              sourceId: 'documentation',
              getItems() {
                return search(query, { limit: 5 })
              },
              getItemUrl({ item }) {
                return item.url
              },
              onSelect: navigate,
            },
          ]
        })
      },
    })

    return holder.current
  })

  return { autocomplete, autocompleteState }
}

function LoadingIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  const id = useId()

  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <circle cx="10" cy="10" r="5.5" strokeLinejoin="round" />
      <path
        stroke={`url(#${id})`}
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.5 10a5.5 5.5 0 1 0-5.5 5.5"
      />
      <defs>
        <linearGradient
          id={id}
          x1="13"
          x2="9.5"
          y1="9"
          y2="15"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}

function HighlightQuery({ text, query }: { text: string; query: string }) {
  return (
    <Highlighter
      highlightClassName="group-aria-selected:underline bg-transparent text-sky-600 dark:text-sky-400"
      searchWords={[query]}
      autoEscape={true}
      textToHighlight={text}
    />
  )
}

function SearchResult({
  result,
  autocomplete,
  collection,
  query,
}: {
  result: Result
  autocomplete: Autocomplete
  collection: AutocompleteCollection<Result>
  query: string
}) {
  const id = useId()

  const sectionTitle = navigation.find((section) =>
    section.links.find((link) => link.href === result.url.split('#')[0]),
  )?.title
  const hierarchy = [sectionTitle, result.pageTitle].filter(
    (x): x is string => typeof x === 'string',
  )

  return (
    <li
      className="group relative block cursor-default px-4 py-3 aria-selected:bg-paper-deep/60"
      aria-labelledby={`${id}-hierarchy ${id}-title`}
      {...autocomplete.getItemProps({
        item: result,
        source: collection.source,
      })}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0 h-full w-px bg-cobalt-500 opacity-0 transition-opacity group-aria-selected:opacity-100"
      />
      <div
        id={`${id}-title`}
        aria-hidden="true"
        className="font-editorial text-[1rem] tracking-[-0.005em] text-ink group-aria-selected:text-cobalt-500"
      >
        <HighlightQuery text={result.title} query={query} />
      </div>
      {hierarchy.length > 0 && (
        <div
          id={`${id}-hierarchy`}
          aria-hidden="true"
          className="mt-1 truncate font-mono text-[0.65rem] tracking-[0.18em] whitespace-nowrap text-ink/55 uppercase"
        >
          {hierarchy.map((item, itemIndex, items) => (
            <Fragment key={itemIndex}>
              <HighlightQuery text={item} query={query} />
              <span
                className={
                  itemIndex === items.length - 1
                    ? 'sr-only'
                    : 'mx-2 text-ink/25'
                }
              >
                /
              </span>
            </Fragment>
          ))}
        </div>
      )}
    </li>
  )
}

function SearchResults({
  autocomplete,
  query,
  collection,
}: {
  autocomplete: Autocomplete
  query: string
  collection: AutocompleteCollection<Result>
}) {
  if (collection.items.length === 0) {
    return (
      <p className="px-6 py-10 text-center font-editorial text-[1.05rem] text-ink/65 italic">
        No results for{' '}
        <span className="text-ink not-italic">&ldquo;{query}&rdquo;</span>.
      </p>
    )
  }

  return (
    <ul {...autocomplete.getListProps()}>
      {collection.items.map((result) => (
        <SearchResult
          key={result.url}
          result={result}
          autocomplete={autocomplete}
          collection={collection}
          query={query}
        />
      ))}
    </ul>
  )
}

const SearchInput = forwardRef<
  HTMLInputElement,
  {
    autocomplete: Autocomplete
    autocompleteState: AutocompleteState<Result> | EmptyObject
    onClose: () => void
  }
>(function SearchInput({ autocomplete, autocompleteState, onClose }, inputRef) {
  const inputProps = autocomplete.getInputProps({ inputElement: null })

  return (
    <div className="group relative flex h-14">
      <SearchIcon className="pointer-events-none absolute top-0 left-5 h-full w-4 fill-ink/55" />
      <input
        ref={inputRef}
        data-autofocus
        className={clsx(
          'flex-auto appearance-none bg-transparent pl-12 font-mono text-[0.9rem] text-ink outline-hidden placeholder:text-ink/35 focus:w-full focus:flex-none [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden [&::-webkit-search-results-button]:hidden [&::-webkit-search-results-decoration]:hidden',
          autocompleteState.status === 'stalled' ? 'pr-12' : 'pr-5',
        )}
        {...inputProps}
        onKeyDown={(event) => {
          if (
            event.key === 'Escape' &&
            !autocompleteState.isOpen &&
            autocompleteState.query === ''
          ) {
            // In Safari, closing the dialog with the escape key can sometimes cause the scroll position to jump to the
            // bottom of the page. This is a workaround for that until we can figure out a proper fix in Headless UI.
            if (document.activeElement instanceof HTMLElement) {
              document.activeElement.blur()
            }

            onClose()
          } else {
            inputProps.onKeyDown(event)
          }
        }}
      />
      {autocompleteState.status === 'stalled' && (
        <div className="absolute inset-y-0 right-4 flex items-center">
          <LoadingIcon className="h-5 w-5 animate-spin stroke-ink/15 text-cobalt-500" />
        </div>
      )}
    </div>
  )
})

function CloseOnNavigation({
  close,
  autocomplete,
}: {
  close: (autocomplete: Autocomplete) => void
  autocomplete: Autocomplete
}) {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  useEffect(() => {
    close(autocomplete)
  }, [pathname, searchParams, close, autocomplete])

  return null
}

function SearchDialog({
  open,
  setOpen,
  className,
}: {
  open: boolean
  setOpen: (open: boolean) => void
  className?: string
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Tracked as state (not a ref) so the autocomplete library receives the
  // input element via render props. Reading `inputRef.current` during render
  // is flagged by `react-hooks/refs`, and the autocomplete API needs the
  // element to wire up keyboard/focus handling.
  const [inputElement, setInputElement] = useState<HTMLInputElement | null>(
    null,
  )

  const close = useCallback(
    (autocomplete: Autocomplete) => {
      setOpen(false)
      autocomplete.setQuery('')
    },
    [setOpen],
  )

  const { autocomplete, autocompleteState } = useAutocomplete({
    close() {
      close(autocomplete)
    },
  })

  useEffect(() => {
    if (open) {
      return
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen(true)
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, setOpen])

  return (
    <>
      <Suspense fallback={null}>
        <CloseOnNavigation close={close} autocomplete={autocomplete} />
      </Suspense>
      <Dialog
        open={open}
        onClose={() => close(autocomplete)}
        className={clsx('fixed inset-0 z-50', className)}
      >
        <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm" />

        <div className="fixed inset-0 overflow-y-auto px-4 py-4 sm:px-6 sm:py-20 md:py-32 lg:px-8 lg:py-[15vh]">
          <DialogPanel className="mx-auto transform-gpu overflow-hidden border border-ink/20 bg-paper shadow-[0_30px_80px_-20px_rgba(12,12,16,0.4)] sm:max-w-xl dark:shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)]">
            <div {...autocomplete.getRootProps({})}>
              <form
                ref={formRef}
                {...autocomplete.getFormProps({
                  inputElement,
                })}
              >
                <SearchInput
                  ref={setInputElement}
                  autocomplete={autocomplete}
                  autocompleteState={autocompleteState}
                  onClose={() => setOpen(false)}
                />
                <div
                  ref={panelRef}
                  className="border-t border-ink/15 bg-paper py-2 empty:hidden"
                  {...autocomplete.getPanelProps({})}
                >
                  {autocompleteState.isOpen && (
                    <SearchResults
                      autocomplete={autocomplete}
                      query={autocompleteState.query}
                      collection={autocompleteState.collections[0]}
                    />
                  )}
                </div>
              </form>
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </>
  )
}

function useSearchProps() {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  return {
    buttonProps: {
      ref: buttonRef,
      onClick() {
        setOpen(true)
      },
    },
    dialogProps: {
      open,
      setOpen: useCallback((open: boolean) => {
        const { width = 0, height = 0 } =
          buttonRef.current?.getBoundingClientRect() ?? {}
        if (!open || (width !== 0 && height !== 0)) {
          setOpen(open)
        }
      }, []),
    },
  }
}

export function Search() {
  const modifierKey = useClientValue<string | undefined>(
    () => (/(Mac|iPhone|iPod|iPad)/i.test(navigator.platform) ? '⌘' : 'Ctrl '),
    undefined,
  )
  const { buttonProps, dialogProps } = useSearchProps()

  return (
    <>
      <button
        type="button"
        className="group flex h-6 w-6 items-center justify-center sm:justify-start md:h-auto md:w-72 md:flex-none md:border md:border-ink/15 md:bg-paper-deep/40 md:py-2 md:pr-3 md:pl-3.5 md:text-sm md:transition md:hover:border-cobalt-500/40 lg:w-80"
        {...buttonProps}
      >
        <SearchIcon className="h-4 w-4 flex-none fill-ink/55 transition group-hover:fill-cobalt-500" />
        <span className="sr-only md:not-sr-only md:ml-2.5 md:font-mono md:text-[0.7rem] md:tracking-[0.18em] md:text-ink/55 md:uppercase">
          Search
        </span>
        {modifierKey && (
          <kbd className="ml-auto hidden font-mono text-[0.65rem] tracking-[0.1em] text-ink/40 md:block">
            <kbd>{modifierKey}</kbd>
            <kbd>K</kbd>
          </kbd>
        )}
      </button>
      <SearchDialog {...dialogProps} />
    </>
  )
}
