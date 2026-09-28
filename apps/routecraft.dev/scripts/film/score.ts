/**
 * Synthesises the platform film's score. The opening A minor tension resolves
 * to C major when Routecraft appears at 12 seconds. Named timeline beats then
 * carry the build, deployment and reuse sequence. No licensed audio is used.
 *
 * Usage: bun scripts/film/score.ts && bun scripts/film/mix.ts
 */
import { join } from 'node:path'

import {
  BEATS,
  FILM_DURATION,
  SCORE_EVENTS,
} from '../../app/components/film/timeline'
import { RATE, encode } from './ffmpeg'

const LENGTH = FILM_DURATION * RATE
const left = new Float32Array(LENGTH)
const right = new Float32Array(LENGTH)
const TAU = Math.PI * 2
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12)

/** The moment the problem is answered; everything before it tightens, everything after it opens. */
const TURN = BEATS.introduction
const NOBODY_ELSE = BEATS.duplication
const SWELL_FROM = 9

/** The harmony resolves when the framework appears, then follows its use. */
const CHORDS: [number, number[]][] = [
  [0, [33, 45, 52, 57, 60]],
  [6, [33, 45, 52, 56, 60]],
  [9, [40, 47, 52, 56, 62]],
  [TURN, [36, 48, 55, 60, 64]],
  [BEATS.build, [36, 48, 55, 60, 64, 67]],
  [BEATS.deploy, [35, 47, 55, 59, 62]],
  [BEATS.finance, [33, 45, 57, 60, 64]],
  [BEATS.sales, [29, 41, 53, 57, 60, 65]],
  [BEATS.schedule, [36, 48, 55, 60, 64]],
  [BEATS.telemetry, [31, 43, 55, 59, 62]],
  [BEATS.payoff, [36, 48, 55, 62, 64, 67]],
  [BEATS.end, [36, 48, 60, 64, 67]],
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

// The pulse under the chaos: a low thump every three quarters of a second,
// growing from "nobody else can use them" and cut off dead on the turn.
for (let at = NOBODY_ELSE; at < TURN - 0.4; at += 0.75) {
  const gain =
    0.05 + 0.16 * Math.pow((at - NOBODY_ELSE) / (TURN - NOBODY_ELSE), 1.5)
  const start = Math.floor(at * RATE)
  for (let i = start; i < start + Math.floor(0.5 * RATE); i++) {
    const t = (i - start) / RATE
    const s =
      gain *
      Math.exp(-t / 0.12) *
      Math.sin(TAU * (38 + 30 * Math.exp(-t / 0.05)) * t)
    add(i, s, s)
  }
}

// The swell before the framework appears: noise through an opening lowpass.
{
  const from = SWELL_FROM
  const to = TURN
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
  const start = Math.floor(TURN * RATE)
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
for (let step = 0, t = TURN; t < BEATS.end; step++, t += 0.3) {
  const upper = chordAt(t).filter((n) => n >= 52)
  const note = upper[step % upper.length] + 12
  const lift = Math.min(1, (t - TURN) / 4)
  pluck(note, t, 0.028 * lift, step % 2 ? 0.35 : 0.65, 0.45)
}

// A note for every card and block that lands.
SCORE_EVENTS.forEach((event, i) => {
  const scale = event.at < TURN ? [69, 72, 74, 76, 79] : [72, 74, 76, 79, 81]
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

const scale = 0.89 / peak
const stereo = new Float32Array(LENGTH * 2)
for (let i = 0; i < LENGTH; i++) {
  stereo[i * 2] = left[i] * scale
  stereo[i * 2 + 1] = right[i] * scale
}

const out = join(import.meta.dir, 'audio', 'music.mp3')
encode(stereo, 2, RATE, out, [
  '-ar',
  '44100',
  '-c:a',
  'libmp3lame',
  '-b:a',
  '160k',
])
console.log(`✓ ${out}`)
