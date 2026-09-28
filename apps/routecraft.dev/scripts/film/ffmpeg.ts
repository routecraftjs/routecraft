/**
 * The film scripts' one dependency outside the workspace: ffmpeg, from PATH or
 * from `FFMPEG`. Audio moves between the scripts as raw float samples, so the
 * synthesis and the mix stay in TypeScript and ffmpeg only decodes and encodes.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const FFMPEG = process.env.FFMPEG ?? 'ffmpeg'
export const RATE = 48000

function run(args: string[], stdin?: Uint8Array): Buffer {
  const result = Bun.spawnSync([FFMPEG, '-v', 'error', '-y', ...args], {
    stdin: stdin ?? 'ignore',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout
}

/** Decodes any audio file to interleaved stereo float samples at RATE. */
export function decodeStereo(file: string): Float32Array {
  const raw = run([
    '-i',
    file,
    '-ac',
    '2',
    '-ar',
    String(RATE),
    '-f',
    'f32le',
    '-',
  ])
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
}

/**
 * Encodes interleaved float samples at `rate` to `out`, with any extra ffmpeg
 * output arguments (filters, codec, bitrate).
 */
export function encode(
  samples: Float32Array,
  channels: number,
  rate: number,
  out: string,
  args: string[],
) {
  const work = mkdtempSync(join(tmpdir(), 'routecraft-film-audio-'))
  const raw = join(work, 'samples.f32')
  writeFileSync(
    raw,
    new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
  )
  try {
    run([
      '-f',
      'f32le',
      '-ar',
      String(rate),
      '-ac',
      String(channels),
      '-i',
      raw,
      ...args,
      out,
    ])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
