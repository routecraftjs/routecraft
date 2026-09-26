/**
 * Mixes the voice and the music into `public/film/soundtrack.mp3`, the one
 * track the player and the MP4 use.
 *
 * The music ducks under the voice: an envelope follows the voice's level and
 * pulls the music down while someone is speaking, then lets it back up in the
 * gaps. Either stem in `scripts/film/audio/` can be replaced (a licensed music
 * track, a recorded read) and remixed without touching the other.
 *
 * Usage: bun scripts/film/mix.ts
 */
import { join } from 'node:path'

import { ROOT } from '../paths'
import { RATE, decodeStereo, encode } from './ffmpeg'

const MUSIC_LEVEL = 0.6
const DUCK = 0.7
const music = decodeStereo(join(import.meta.dir, 'audio', 'music.mp3'))
const voice = decodeStereo(join(import.meta.dir, 'audio', 'voice.mp3'))
const frames = Math.max(music.length, voice.length) / 2
const out = new Float32Array(frames * 2)

const attack = 1 - Math.exp(-1 / (0.03 * RATE))
const release = 1 - Math.exp(-1 / (0.6 * RATE))
let level = 0
let duck = 0
for (let i = 0; i < frames; i++) {
  const l = voice[i * 2] ?? 0
  const r = voice[i * 2 + 1] ?? 0
  const peak = Math.max(Math.abs(l), Math.abs(r))
  level += (peak - level) * (peak > level ? attack : release)
  const target = Math.min(1, level / 0.04)
  duck += (target - duck) * (target > duck ? attack : release)
  const gain = MUSIC_LEVEL * (1 - DUCK * duck)
  out[i * 2] = l + (music[i * 2] ?? 0) * gain
  out[i * 2 + 1] = r + (music[i * 2 + 1] ?? 0) * gain
}

const target = join(ROOT, 'public', 'film', 'soundtrack.mp3')
encode(out, 2, RATE, target, [
  '-af',
  'loudnorm=I=-16:TP=-1.5:LRA=11',
  '-ar',
  '44100',
  '-c:a',
  'libmp3lame',
  '-b:a',
  '128k',
])
console.log(`✓ ${target}`)
