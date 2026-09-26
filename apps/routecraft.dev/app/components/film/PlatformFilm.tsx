import { useEffect, useRef, useState } from 'react'

import { ScaledFrame } from '@/components/ScaledFrame'

import { FilmFrame } from './FilmFrame'
import {
  FILM_DURATION,
  FILM_HEIGHT,
  FILM_POSTER_TIME,
  FILM_WIDTH,
  TRANSCRIPT,
} from './timeline'

const SCORE_SRC = '/film/score.mp3'
const MP4_SRC = '/film/routecraft-platform.mp4'

/**
 * The platform film, drawn live rather than streamed: `FilmFrame` renders any
 * moment from its time, and this player only decides what time it is.
 *
 * It starts muted when it scrolls into view, since browsers only allow sound
 * after a click. With sound on, the audio element is the clock, so picture and
 * music cannot drift apart. With reduced motion it holds on the settled
 * platform until someone presses play. The same film is recorded to an MP4
 * by `scripts/film/render.ts` for anywhere that cannot run it live.
 */
export function PlatformFilm() {
  const [t, setT] = useState(FILM_POSTER_TIME)
  const [playing, setPlaying] = useState(false)
  const [sound, setSound] = useState(false)
  const time = useRef(FILM_POSTER_TIME)
  const started = useRef(false)
  const pausedByViewer = useRef(false)
  const audio = useRef<HTMLAudioElement>(null)
  const frame = useRef<HTMLDivElement>(null)

  const seek = (next: number) => {
    time.current = next
    setT(next)
    if (audio.current && sound) audio.current.currentTime = next
  }

  const play = () => {
    if (!started.current) {
      started.current = true
      seek(0)
    }
    setPlaying(true)
  }

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const element = frame.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (pausedByViewer.current) return
        if (entry.isIntersecting) play()
        else setPlaying(false)
      },
      { threshold: 0.35 },
    )
    observer.observe(element)
    return () => observer.disconnect()
    // play only reads refs and setters, which are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!playing) {
      audio.current?.pause()
      return
    }
    if (sound) void audio.current?.play()
    const start = performance.now()
    const from = time.current
    let request = 0
    const tick = (now: number) => {
      const track = audio.current
      const next =
        sound && track && !track.paused
          ? track.currentTime
          : (from + (now - start) / 1000) % FILM_DURATION
      time.current = next
      setT(next)
      request = requestAnimationFrame(tick)
    }
    request = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(request)
  }, [playing, sound])

  const togglePlay = () => {
    if (playing) {
      pausedByViewer.current = true
      setPlaying(false)
    } else {
      pausedByViewer.current = false
      play()
    }
  }

  const toggleSound = async () => {
    const track = audio.current
    if (!track) return
    if (sound) {
      track.pause()
      setSound(false)
      return
    }
    if (!started.current) {
      started.current = true
      time.current = 0
      setT(0)
    }
    track.currentTime = time.current
    try {
      await track.play()
      setSound(true)
      pausedByViewer.current = false
      setPlaying(true)
    } catch {
      setSound(false)
    }
  }

  const restart = () => {
    started.current = true
    seek(0)
    if (audio.current) audio.current.currentTime = 0
    pausedByViewer.current = false
    setPlaying(true)
  }

  return (
    <figure className="m-0">
      <div ref={frame} className="relative border border-ink/15">
        <ScaledFrame
          width={FILM_WIDTH}
          height={FILM_HEIGHT}
          label="Film: every team builds its own AI tools; Routecraft turns them into capabilities on one platform."
        >
          <FilmFrame t={t} />
        </ScaledFrame>
        <div
          aria-hidden="true"
          className="absolute bottom-0 left-0 h-0.5 bg-cobalt-500"
          style={{ width: `${(t / FILM_DURATION) * 100}%` }}
        />
      </div>
      <audio ref={audio} src={SCORE_SRC} preload="none" loop />
      <figcaption className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 font-mono text-[0.7rem] tracking-[0.18em] text-ink/65 uppercase">
        <button
          type="button"
          onClick={togglePlay}
          className="tracking-[0.18em] uppercase hover:text-cobalt-500"
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          onClick={toggleSound}
          aria-pressed={sound}
          className="tracking-[0.18em] uppercase hover:text-cobalt-500"
        >
          {sound ? 'Sound off' : 'Sound on'}
        </button>
        <button
          type="button"
          onClick={restart}
          className="tracking-[0.18em] uppercase hover:text-cobalt-500"
        >
          From the start
        </button>
        <span className="flex-1" />
        <a
          href={MP4_SRC}
          download
          className="tracking-[0.18em] uppercase hover:text-cobalt-500"
        >
          Download the film (MP4)
        </a>
      </figcaption>
      <details className="mt-4 text-[0.95rem] leading-[1.7] text-ink/70">
        <summary className="cursor-pointer font-mono text-[0.7rem] tracking-[0.18em] text-ink/55 uppercase hover:text-cobalt-500">
          Transcript
        </summary>
        <ol className="mt-3 list-none space-y-1 p-0">
          {TRANSCRIPT.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </details>
    </figure>
  )
}
