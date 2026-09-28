/**
 * The slice of kokoro-js that `voice.ts` uses. The package is installed only
 * when the voice is regenerated (`bun add --no-save kokoro-js`), because its
 * model runtime is too heavy to carry in the site's dependencies.
 */
declare module 'kokoro-js' {
  export class KokoroTTS {
    static from_pretrained(
      model: string,
      options: { dtype: 'fp32' | 'fp16' | 'q8' | 'q4'; device: 'cpu' },
    ): Promise<KokoroTTS>
    voices: Record<string, unknown>
    generate(
      text: string,
      options: { voice: string; speed?: number },
    ): Promise<{ audio: Float32Array; sampling_rate: number }>
  }
}
