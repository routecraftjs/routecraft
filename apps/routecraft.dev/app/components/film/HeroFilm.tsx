import {
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Dialog, DialogBackdrop, DialogPanel } from '@headlessui/react'

import { ScaledFrame } from '@/components/ScaledFrame'

import { FilmFrame } from './FilmFrame'
import {
  FILM_DURATION,
  FILM_HEIGHT,
  FILM_POSTER_TIME,
  FILM_WIDTH,
} from './timeline'

const LABEL =
  'Film: every team builds its own AI tools; Routecraft turns them into capabilities on one platform.'
const RUNTIME = `${Math.floor(FILM_DURATION / 60)}:${String(FILM_DURATION % 60).padStart(2, '0')}`

interface FilmControls {
  t: number
  open: boolean
  playing: boolean
  /** Opens the lightbox and plays from the start. */
  watch: () => void
  close: () => void
  togglePlay: () => void
  restart: () => void
  /** Marks the preview; the film only plays while it is on screen. */
  previewRef: (element: HTMLElement | null) => void
}

const FilmContext = createContext<FilmControls | null>(null)

function useFilm(): FilmControls {
  const film = useContext(FilmContext)
  if (!film) throw new Error('useFilm needs a FilmProvider above it')
  return film
}

/**
 * The platform film, drawn live rather than streamed: `FilmFrame` renders any
 * moment from its time, and this provider only decides what time it is.
 *
 * One clock serves two views. In the page the film loops while it is on
 * screen; `watch()` opens it in a lightbox from the start. It is silent for
 * now: the voice and score come back with the reworked cut, and the audio
 * element becomes the clock again then. Under reduced motion the preview holds
 * on the settled platform until someone asks for the film.
 */
export function FilmProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState(FILM_POSTER_TIME)
  const [open, setOpen] = useState(false)
  const [playing, setPlaying] = useState(false)
  const time = useRef(FILM_POSTER_TIME)
  const started = useRef(false)
  const inView = useRef(false)
  const isOpen = useRef(false)
  const observer = useRef<IntersectionObserver | null>(null)

  const seek = (next: number) => {
    time.current = next
    setT(next)
  }

  // Stable, or React would rebuild the observer on every animation frame.
  const previewRef = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!element || typeof IntersectionObserver === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    observer.current = new IntersectionObserver(
      ([entry]) => {
        inView.current = entry.isIntersecting
        if (isOpen.current) return
        if (entry.isIntersecting && !started.current) {
          started.current = true
          time.current = 0
          setT(0)
        }
        setPlaying(entry.isIntersecting)
      },
      { threshold: 0.35 },
    )
    observer.current.observe(element)
  }, [])

  useEffect(() => () => observer.current?.disconnect(), [])

  useEffect(() => {
    if (!playing) return
    const start = performance.now()
    const from = time.current
    let request = 0
    const tick = (now: number) => {
      const elapsed = from + (now - start) / 1000
      // The page loops; the lightbox plays once and holds on the end card.
      if (isOpen.current && elapsed >= FILM_DURATION) {
        time.current = FILM_DURATION - 0.01
        setT(time.current)
        setPlaying(false)
        return
      }
      time.current = elapsed % FILM_DURATION
      setT(time.current)
      request = requestAnimationFrame(tick)
    }
    request = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(request)
  }, [playing])

  const watch = () => {
    isOpen.current = true
    started.current = true
    setOpen(true)
    seek(0)
    setPlaying(true)
  }

  const close = () => {
    isOpen.current = false
    setOpen(false)
    setPlaying(inView.current)
  }

  const togglePlay = () => {
    if (playing) return setPlaying(false)
    if (time.current >= FILM_DURATION - 0.1) seek(0)
    setPlaying(true)
  }

  const restart = () => {
    seek(0)
    setPlaying(true)
  }

  return (
    <FilmContext.Provider
      value={{
        t,
        open,
        playing,
        watch,
        close,
        togglePlay,
        restart,
        previewRef,
      }}
    >
      {children}
      <FilmLightbox />
    </FilmContext.Provider>
  )
}

/** Memoised so the preview stops redrawing while the lightbox owns the clock. */
const Frame = memo(function Frame({ t }: { t: number }) {
  return (
    <ScaledFrame width={FILM_WIDTH} height={FILM_HEIGHT} label={LABEL}>
      <FilmFrame t={t} />
    </ScaledFrame>
  )
})

/** The film in the page: looping, and one click from the lightbox. */
export function FilmPreview() {
  const { t, open, watch, previewRef } = useFilm()

  return (
    <div ref={previewRef} className="group/film relative border border-ink/15">
      <Frame t={open ? FILM_POSTER_TIME : t} />
      <div
        aria-hidden="true"
        className="absolute bottom-0 left-0 h-0.5 bg-cobalt-500"
        style={{ width: `${(t / FILM_DURATION) * 100}%` }}
      />
      <button
        type="button"
        onClick={watch}
        aria-label={`Watch the film, ${RUNTIME}`}
        className="absolute inset-0 flex h-full w-full cursor-pointer items-end justify-start border-0 bg-transparent p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt-500"
      >
        <span className="inline-flex items-center gap-3 bg-ink px-4 py-2.5 font-mono text-[0.65rem] tracking-[0.22em] text-paper uppercase transition group-hover/film:bg-cobalt-500">
          <span aria-hidden="true">▶</span>
          Watch the film · {RUNTIME}
        </span>
      </button>
    </div>
  )
}

/** Opens the film from anywhere inside the provider, such as a hero button. */
export function WatchFilmButton({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  const { watch } = useFilm()
  return (
    <button type="button" onClick={watch} className={className}>
      {children}
    </button>
  )
}

const CONTROL =
  'font-mono text-[0.65rem] tracking-[0.22em] text-paper/70 uppercase transition hover:text-paper'

function FilmLightbox() {
  const { t, open, playing, close, togglePlay, restart } = useFilm()

  return (
    <Dialog open={open} onClose={close} className="relative z-[60]">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-ink/90 backdrop-blur-sm transition duration-300 ease-out data-[closed]:opacity-0"
      />
      <button
        type="button"
        onClick={close}
        className={`fixed top-5 right-5 z-10 inline-flex items-center gap-2 sm:top-7 sm:right-7 ${CONTROL}`}
      >
        <span>Close</span>
        <span aria-hidden="true" className="text-[0.9rem] leading-none">
          ✕
        </span>
      </button>
      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4 sm:p-10">
          {/* 16:9 at the largest size that leaves room for the controls. */}
          <DialogPanel
            transition
            className="w-full max-w-[min(100%,calc((100vh-8rem)*16/9))] transition duration-300 ease-out data-[closed]:scale-[0.97] data-[closed]:opacity-0"
          >
            <div className="relative border border-paper/15 bg-paper">
              {open ? <Frame t={t} /> : null}
              <div
                aria-hidden="true"
                className="absolute bottom-0 left-0 h-0.5 bg-cobalt-500"
                style={{ width: `${(t / FILM_DURATION) * 100}%` }}
              />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
              <button type="button" onClick={togglePlay} className={CONTROL}>
                {playing ? 'Pause' : 'Play'}
              </button>
              <button type="button" onClick={restart} className={CONTROL}>
                From the start
              </button>
            </div>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  )
}
