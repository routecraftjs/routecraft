/**
 * Writes the platform film's score to `public/film/score.mp3`.
 *
 * The music is synthesised here rather than licensed, so it can be regenerated
 * whenever the picture changes and carries no rights question. It follows the
 * film's arc: a dark A minor drone under the board filling up, a swell while
 * the harness forms, a lift into C major when tools become capabilities, an
 * arpeggio while the platform draws itself, and a soft note on every card and
 * block landing, taken from `SCORE_EVENTS` so sound and picture share one
 * timeline. Swap in a licensed track by replacing the MP3 at the same path.
 *
 * Needs ffmpeg on PATH (or FFMPEG pointing at one) to encode the MP3.
 *
 * Usage: bun scripts/film/score.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FILM_DURATION, SCORE_EVENTS } from '../../app/components/film/timeline'
import { ROOT } from '../paths'

const RATE = 48000
const LENGTH = FILM_DURATION * RATE
const left = new Float32Array(LENGTH)
const right = new Float32Array(LENGTH)
const TAU = Math.PI * 2
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12)

/** Chords as MIDI notes, each held from its start until the next one. */
const CHORDS: [number, number[]][] = [
  [0, [33, 45, 52, 57, 60]],
  [20.4, [41, 48, 53, 57, 64]],
  [24.6, [38, 50, 53, 57, 62]],
  [27.6, [40, 47, 52, 57, 59]],
  [31, [36, 48, 55, 60, 64]],
  [38.8, [36, 48, 55, 60, 64, 67]],
  [42.4, [35, 47, 55, 59, 62]],
  [45.6, [33, 45, 57, 60, 64]],
  [48, [29, 41, 53, 57, 60, 65]],
  [50.4, [29, 41, 53, 57, 60]],
  [53, [36, 48, 55, 60, 64]],
  [55.6, [31, 43, 55, 59, 62]],
  [58, [36, 48, 55, 60, 64, 67]],
  [60.2, [36, 48, 55, 62, 64, 67]],
  [66, [36, 48, 60, 64, 67]],
]

function add(i: number, l: number, r: number) {
  if (i < 0 || i >= LENGTH) return
  left[i] += l
  right[i] += r
}

/** A held chord tone: three detuned sines with a soft second harmonic. */
function pad(midi: number, from: number, to: number) {
  const attack = 1.4
  const release = 1.8
  const f = hz(midi)
  const gain = midi < 45 ? 0.06 : 0.035
  const start = Math.floor(from * RATE)
  const end = Math.min(LENGTH, Math.floor((to + release) * RATE))
  for (let i = start; i < end; i++) {
    const t = i / RATE
    const env =
      Math.min(1, (t - from) / attack) *
      (t > to ? Math.max(0, 1 - (t - to) / release) : 1)
    let v = 0
    for (const cents of [-3, 0, 3]) {
      const fc = f * Math.pow(2, cents / 1200)
      v += Math.sin(TAU * fc * t) + 0.18 * Math.sin(TAU * 2 * fc * t)
    }
    const wobble = 1 + 0.03 * Math.sin(TAU * 0.11 * t + midi)
    const s = v * gain * env * wobble
    const pan = 0.5 + 0.3 * Math.sin(midi)
    add(i, s * (1 - pan) * 1.4, s * pan * 1.4)
  }
}

/** A short plucked tone. */
function pluck(
  midi: number,
  at: number,
  gain: number,
  pan: number,
  decay = 0.9,
) {
  const f = hz(midi)
  const start = Math.floor(at * RATE)
  const end = Math.min(LENGTH, start + Math.floor(decay * 4 * RATE))
  for (let i = start; i < end; i++) {
    const t = (i - start) / RATE
    const env = Math.min(1, t / 0.006) * Math.exp(-t / decay)
    const s =
      gain *
      env *
      (Math.sin(TAU * f * t) +
        0.3 * Math.sin(TAU * 2 * f * t) * Math.exp(-t / 0.2))
    add(i, s * (1 - pan), s * pan)
  }
}

for (let c = 0; c < CHORDS.length; c++) {
  const [from, notes] = CHORDS[c]
  const to = c + 1 < CHORDS.length ? CHORDS[c + 1][0] : FILM_DURATION
  for (const note of notes) pad(note, from, to)
}

/** A seeded generator, so every run writes the same file. */
let seed = 0x2f6e2b1
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 0xffffffff - 0.5
}

// The swell while the harness forms: noise through a lowpass that opens up.
{
  const from = 24.6
  const to = 31
  let low = 0
  for (let i = Math.floor(from * RATE); i < Math.floor(to * RATE); i++) {
    const p = (i / RATE - from) / (to - from)
    const cutoff = 150 + 3800 * p * p
    low += (noise() - low) * (1 - Math.exp((-TAU * cutoff) / RATE))
    const s = low * 0.35 * p * p
    add(i, s, s)
  }
}

// A low hit where the tools become capabilities.
{
  const start = Math.floor(31 * RATE)
  for (let i = start; i < start + 3 * RATE; i++) {
    const t = (i - start) / RATE
    const s =
      0.22 *
      Math.exp(-t / 0.9) *
      Math.sin(TAU * (48 + 20 * Math.exp(-t / 0.08)) * t)
    add(i, s, s)
  }
}

const chordAt = (t: number) =>
  CHORDS.reduce((current, chord) => (chord[0] <= t ? chord : current))[1]

// The arpeggio under the platform building itself.
for (let step = 0, t = 38.8; t < 66; step++, t += 0.3) {
  const upper = chordAt(t).filter((n) => n >= 52)
  const note = upper[step % upper.length] + 12
  const lift = Math.min(1, (t - 38.8) / 4)
  pluck(note, t, 0.028 * lift, step % 2 ? 0.35 : 0.65, 0.45)
}

// A note for every card and block that lands.
SCORE_EVENTS.forEach((event, i) => {
  const scale = event.at < 31 ? [69, 72, 74, 76, 79] : [72, 74, 76, 79, 81]
  const note = scale[(i * 3) % scale.length]
  pluck(note, event.at, 0.075 * event.weight, 0.25 + (0.5 * ((i * 7) % 5)) / 4)
})

// A small room: two feedback delays per side.
for (const [channel, times] of [
  [left, [0.137, 0.211]],
  [right, [0.149, 0.197]],
] as const) {
  const dry = Float32Array.from(channel)
  for (const time of times) {
    const d = Math.floor(time * RATE)
    const line = new Float32Array(LENGTH)
    let lowpass = 0
    for (let i = d; i < LENGTH; i++) {
      lowpass += (dry[i - d] + line[i - d] * 0.5 - lowpass) * 0.35
      line[i] = lowpass
      channel[i] += lowpass * 0.14
    }
  }
}

let peak = 0
for (let i = 0; i < LENGTH; i++) {
  const t = i / RATE
  const fade =
    Math.min(1, t / 1.2) *
    Math.min(1, Math.max(0, (FILM_DURATION - 0.3 - t) / 2.5))
  left[i] *= fade
  right[i] *= fade
  peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
}

const wav = Buffer.alloc(44 + LENGTH * 4)
wav.write('RIFF', 0)
wav.writeUInt32LE(36 + LENGTH * 4, 4)
wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(2, 22)
wav.writeUInt32LE(RATE, 24)
wav.writeUInt32LE(RATE * 4, 28)
wav.writeUInt16LE(4, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(LENGTH * 4, 40)
const scale = 0.89 / peak
for (let i = 0; i < LENGTH; i++) {
  wav.writeInt16LE(Math.round(left[i] * scale * 32767), 44 + i * 4)
  wav.writeInt16LE(Math.round(right[i] * scale * 32767), 46 + i * 4)
}

const work = mkdtempSync(join(tmpdir(), 'routecraft-score-'))
const raw = join(work, 'score.wav')
writeFileSync(raw, wav)
const out = join(ROOT, 'public', 'film', 'score.mp3')
const ffmpeg = Bun.spawnSync([
  process.env.FFMPEG ?? 'ffmpeg',
  '-v',
  'error',
  '-y',
  '-i',
  raw,
  '-af',
  'loudnorm=I=-18:TP=-1.5:LRA=11',
  '-ar',
  '44100',
  '-c:a',
  'libmp3lame',
  '-b:a',
  '128k',
  out,
])
rmSync(work, { recursive: true, force: true })
if (ffmpeg.exitCode !== 0) throw new Error(ffmpeg.stderr.toString())
console.log(`✓ ${out}`)
