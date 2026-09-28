/**
 * Speaks the film's narration into `scripts/film/audio/voice.mp3`.
 *
 * Each line of `NARRATION` is synthesised with Kokoro, an open (Apache 2.0)
 * text-to-speech model that runs locally, and placed at its start time. A line
 * that runs past its window is spoken up to 15% faster; one that needs more
 * than that fails, and the line should be shortened instead.
 *
 * The model runtime is not a site dependency. Install it for the run only:
 *
 *   bun add --no-save kokoro-js
 *   bun scripts/film/voice.ts            VOICE=bm_george picks another voice
 *   bun scripts/film/mix.ts              then remix the soundtrack
 */
import { KokoroTTS } from 'kokoro-js'
import { join } from 'node:path'

import { FILM_DURATION, NARRATION } from '../../app/components/film/timeline'
import { encode } from './ffmpeg'

const VOICE = process.env.VOICE ?? 'bf_emma'
const MAX_SPEED = 1.15

/** Spellings the model reads wrongly as written: "Routecraft" gains a syllable, "SharePoint" blurs under music. */
const SPOKEN: Record<string, string> = {
  Routecraft: 'Route craft',
  SharePoint: 'Share Point',
}
const spoken = (text: string) =>
  Object.entries(SPOKEN).reduce(
    (out, [word, say]) => out.replaceAll(word, say),
    text,
  )

const tts = await KokoroTTS.from_pretrained(
  'onnx-community/Kokoro-82M-v1.0-ONNX',
  { dtype: 'fp32', device: 'cpu' },
)
if (!(VOICE in tts.voices)) throw new Error(`unknown voice ${VOICE}`)

let track: Float32Array | undefined
let rate = 0
for (const line of NARRATION) {
  const window = line.end - line.at
  let speech = await tts.generate(spoken(line.text), { voice: VOICE })
  let seconds = speech.audio.length / speech.sampling_rate
  let speed = 1
  // Speed does not shorten speech exactly in proportion, so fit, then retry at the limit.
  for (const next of [
    Math.min(MAX_SPEED, (seconds / window) * 1.03),
    MAX_SPEED,
  ]) {
    if (seconds <= window || next <= speed) continue
    speed = next
    speech = await tts.generate(spoken(line.text), { voice: VOICE, speed })
    seconds = speech.audio.length / speech.sampling_rate
  }
  if (seconds > window)
    throw new Error(
      `"${line.text}" needs ${seconds.toFixed(1)}s of a ${window.toFixed(1)}s window even at x${speed.toFixed(2)}: shorten it`,
    )
  rate = speech.sampling_rate
  track ??= new Float32Array(Math.ceil(FILM_DURATION * rate))
  track.set(
    speech.audio.subarray(0, track.length - Math.floor(line.at * rate)),
    Math.floor(line.at * rate),
  )
  console.log(
    `${line.at.toFixed(1)}s  ${seconds.toFixed(2)}s of ${window.toFixed(1)}s${speed > 1 ? `  x${speed.toFixed(2)}` : ''}  ${line.text}`,
  )
}

const out = join(import.meta.dir, 'audio', 'voice.mp3')
encode(track as Float32Array, 1, rate, out, [
  '-c:a',
  'libmp3lame',
  '-b:a',
  '96k',
])
console.log(`✓ ${out} (${VOICE})`)
