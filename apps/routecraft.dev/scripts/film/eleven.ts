/**
 * Speaks the film's narration with ElevenLabs into `scripts/film/audio/voice.mp3`,
 * the same stem `voice.ts` writes with Kokoro, so `mix.ts` takes either.
 *
 * By default the whole transcript is read as one take, so the voice carries its
 * intonation from sentence to sentence. The timestamped endpoint says where
 * every character falls in the take; the take is cut in the quiet between two
 * lines (see `cutBetween`), and each line is placed so its first word lands on
 * its `at` in the timeline. `--lines` reads every line as its own request
 * instead, for comparison. The raw take and its alignment are kept beside the
 * stem as `eleven-take.mp3` and `eleven-take.json`, and reused while the
 * transcript, voice and model are unchanged, so retiming the film is free.
 *
 * A line that runs past its window is reported, never sped up: retime the
 * timeline to the read instead.
 *
 * Needs ELEVENLABS_API_KEY; ELEVENLABS_VOICE_ID overrides the narrator and
 * ELEVENLABS_MODEL defaults
 * to `eleven_v4`.
 *
 * Usage: bun scripts/film/eleven.ts [--lines] && bun scripts/film/mix.ts
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FILM_DURATION, NARRATION } from '../../app/components/film/timeline'
import { RATE, decodeStereo, encode } from './ffmpeg'

const KEY = process.env.ELEVENLABS_API_KEY
/** The film's narrator; ELEVENLABS_VOICE_ID overrides it for a voice test. */
const VOICE = process.env.ELEVENLABS_VOICE_ID ?? 'C9fbwSpEaejywLWx722Z'
const MODEL = process.env.ELEVENLABS_MODEL ?? 'eleven_v4'
const AUDIO = join(import.meta.dir, 'audio')
/** Short fades at every cut, so a line never starts or ends on a click. */
const FADE = Math.floor(0.012 * RATE)

/**
 * Where to cut the take between two lines, in seconds. The alignment runs
 * about a tenth of a second late, so the next line's first sound often starts
 * before its timestamp and a cut between the timestamps clips it. The cut goes
 * in the middle of the first stretch of real silence after the line, found in
 * the audio, so a breath before the next line travels with it. A silence is at least 30 ms long, so the closure of a
 * consonant inside a word never counts; where the voice runs two lines
 * together with no silence at all, the cut goes at the deepest dip at the
 * boundary itself. `onset` is where the next line's words begin, after the
 * last silence and any breath, which is what lands on the line's `at`.
 */
function cutBetween(samples: Float32Array, end: number, next: number) {
  const step = Math.floor(0.01 * RATE)
  const level = (at: number) => {
    let sum = 0
    for (let j = at; j < at + step; j++) sum += (samples[j] ?? 0) ** 2
    return 10 * Math.log10(sum / step + 1e-12)
  }
  const from = Math.max(0, Math.floor((end - 0.2) * RATE))
  const to = Math.min(samples.length - step, Math.floor((next + 0.1) * RATE))
  const runs: [number, number][] = []
  let start = -1
  for (let i = from; i <= to; i += step) {
    const silent = i < to && level(i) < -60
    if (silent && start < 0) start = i
    if (!silent && start >= 0) {
      if (i - start >= 3 * step) runs.push([start, i])
      start = -1
    }
  }
  if (runs.length > 0)
    return {
      cut: (runs[0][0] + runs[0][1]) / 2 / RATE,
      onset: runs[runs.length - 1][1] / RATE,
    }
  let deepest = Math.floor((end - 0.05) * RATE)
  for (let i = deepest; i < to; i += step)
    if (level(i) < level(deepest)) deepest = i
  const cut = (deepest + step / 2) / RATE
  return { cut, onset: cut }
}

interface Alignment {
  characters: string[]
  character_start_times_seconds: number[]
  character_end_times_seconds: number[]
}

interface Speech {
  mp3: Uint8Array
  samples: Float32Array
  alignment: Alignment
}

async function speak(text: string): Promise<Speech> {
  if (!KEY) throw new Error('set ELEVENLABS_API_KEY')
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': KEY as string,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text, model_id: MODEL }),
    },
  )
  if (!response.ok)
    throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`)
  const body = (await response.json()) as {
    audio_base64: string
    alignment: Alignment
  }
  const mp3 = Uint8Array.from(Buffer.from(body.audio_base64, 'base64'))
  return { mp3, samples: mono(mp3), alignment: body.alignment }
}

function mono(mp3: Uint8Array): Float32Array {
  const work = mkdtempSync(join(tmpdir(), 'routecraft-eleven-'))
  try {
    const file = join(work, 'speech.mp3')
    writeFileSync(file, mp3)
    const stereo = decodeStereo(file)
    const samples = new Float32Array(stereo.length / 2)
    for (let i = 0; i < samples.length; i++) samples[i] = stereo[i * 2]
    return samples
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const TAKE_MP3 = join(AUDIO, 'eleven-take.mp3')
const TAKE_JSON = join(AUDIO, 'eleven-take.json')

interface SavedTake {
  text: string
  voice: string
  model: string
  alignment: Alignment
}

/** A retime must not buy the same read twice: the saved take is reused while its text, voice and model still match. */
async function oneTake(text: string): Promise<Speech> {
  if (existsSync(TAKE_MP3) && existsSync(TAKE_JSON)) {
    const saved = JSON.parse(readFileSync(TAKE_JSON, 'utf8')) as SavedTake
    if (saved.text === text && saved.voice === VOICE && saved.model === MODEL) {
      console.log(`reusing ${TAKE_MP3}`)
      const mp3 = new Uint8Array(readFileSync(TAKE_MP3))
      return { mp3, samples: mono(mp3), alignment: saved.alignment }
    }
  }
  const take = await speak(text)
  writeFileSync(TAKE_MP3, take.mp3)
  const saved: SavedTake = {
    text,
    voice: VOICE,
    model: MODEL,
    alignment: take.alignment,
  }
  writeFileSync(TAKE_JSON, JSON.stringify(saved, null, 2))
  return take
}

const track = new Float32Array(Math.ceil(FILM_DURATION * RATE))

/** Mixes `samples[from, to)` into the track so that sample `from` lands at `at` seconds. */
function place(samples: Float32Array, from: number, to: number, at: number) {
  const offset = Math.round(at * RATE) - from
  for (let i = Math.max(0, from); i < Math.min(samples.length, to); i++) {
    const j = i + offset
    if (j < 0 || j >= track.length) continue
    const edge = Math.min(1, (i - from) / FADE, (to - 1 - i) / FADE)
    track[j] += samples[i] * edge
  }
}

function report(i: number, spoken: number) {
  const line = NARRATION[i]
  const window = line.end - line.at
  const flag =
    spoken > window ? `  OVER by ${(spoken - window).toFixed(2)}s` : ''
  console.log(
    `${line.at.toFixed(1)}s  ${spoken.toFixed(2)}s of ${window.toFixed(1)}s${flag}  ${line.text}`,
  )
}

mkdirSync(AUDIO, { recursive: true })

if (process.argv.includes('--lines')) {
  for (const [i, line] of NARRATION.entries()) {
    const speech = await speak(line.text)
    const starts = speech.alignment.character_start_times_seconds
    const ends = speech.alignment.character_end_times_seconds
    const first = starts[0]
    place(
      speech.samples,
      Math.floor(first * RATE),
      speech.samples.length,
      line.at,
    )
    report(i, ends[ends.length - 1] - first)
  }
} else {
  const text = NARRATION.map((line) => line.text).join(' ')
  const take = await oneTake(text)
  const { characters, character_start_times_seconds: starts } = take.alignment
  const ends = take.alignment.character_end_times_seconds
  if (characters.join('') !== text)
    throw new Error('the alignment does not match the transcript it was sent')

  let offset = 0
  const spans = NARRATION.map((line) => {
    const first = offset
    const last = offset + line.text.length - 1
    offset += line.text.length + 1
    return { start: starts[first], end: ends[last] }
  })
  const cuts = spans
    .slice(1)
    .map((span, i) => cutBetween(take.samples, spans[i].end, span.start))
  spans.forEach((span, i) => {
    const before = i === 0 ? 0 : cuts[i - 1].cut
    const onset = i === 0 ? span.start : cuts[i - 1].onset
    const after =
      i === spans.length - 1 ? take.samples.length / RATE : cuts[i].cut
    place(
      take.samples,
      Math.floor(before * RATE),
      Math.floor(after * RATE),
      NARRATION[i].at - (onset - before),
    )
    report(i, span.end - onset)
  })
  console.log(
    `✓ ${TAKE_MP3} (${(take.samples.length / RATE).toFixed(1)}s as read)`,
  )
}

const out = join(AUDIO, 'voice.mp3')
encode(track, 1, RATE, out, ['-c:a', 'libmp3lame', '-b:a', '128k'])
console.log(`✓ ${out} (${MODEL}, ${VOICE})`)
