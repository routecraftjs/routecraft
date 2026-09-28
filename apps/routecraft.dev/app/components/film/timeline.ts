/** The film's single clock, shared by its player, narration and score. */
export const FILM_WIDTH = 1920
export const FILM_HEIGHT = 1080
export const FILM_DURATION = 60
export const FILM_POSTER_TIME = 42

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
export const ease = (x: number) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
export const ramp = (t: number, start: number, duration: number) =>
  ease(clamp01((t - start) / duration))
export const span = (t: number, from: number, to: number, fade = 0.45) =>
  Math.min(ramp(t, from, fade), 1 - ramp(t, to - fade, fade))
export const mix = (a: number, b: number, p: number) => a + (b - a) * p

/** Named story beats keep the picture and the music in step. */
export const BEATS = {
  problem: 0,
  duplication: 6,
  introduction: 12,
  build: 19.4,
  deploy: 26.8,
  finance: 33.6,
  sales: 36.4,
  schedule: 39.8,
  telemetry: 45.4,
  payoff: 50.4,
  end: 55.2,
} as const

export const NARRATION: { at: number; end: number; text: string }[] = [
  {
    at: 0.4,
    end: 5.8,
    text: 'Your teams are building useful AI tools. But the work is fragmented.',
  },
  {
    at: 6,
    end: 11.7,
    text: 'Scattered scripts. Personal logins. The next team builds the same thing again.',
  },
  {
    at: 12,
    end: 19.1,
    text: 'Routecraft is an open source framework for AI capabilities your teams can run and reuse.',
  },
  {
    at: 19.5,
    end: 26.5,
    text: 'Start with one: find overdue invoices. Build it in TypeScript. Test it on your laptop.',
  },
  {
    at: 26.9,
    end: 33.3,
    text: 'Deploy it on your infrastructure. Service credentials. Access rules you control.',
  },
  {
    at: 33.7,
    end: 39.5,
    text: 'Finance calls it from an agent. Sales, from their editor.',
  },
  {
    at: 39.9,
    end: 45.1,
    text: 'Run it on a schedule. Same capability. No duplicated integration.',
  },
  {
    at: 45.5,
    end: 50.1,
    text: 'Enable telemetry. Record who called it, and what happened.',
  },
  {
    at: 50.5,
    end: 54.8,
    text: 'What one team proves, every team can use.',
  },
  { at: 55.6, end: 59.2, text: 'Routecraft. Built to be used.' },
]
export const TRANSCRIPT = NARRATION.map((line) => line.text)

export const SCORE_EVENTS = [
  { at: 1.2, weight: 0.6 },
  { at: 2.2, weight: 0.6 },
  { at: 3.2, weight: 0.6 },
  { at: 7.2, weight: 0.8 },
  { at: BEATS.introduction, weight: 1.2 },
  { at: 21, weight: 0.8 },
  { at: 25, weight: 1 },
  { at: 29, weight: 1 },
  { at: 31, weight: 0.7 },
  { at: BEATS.finance + 0.8, weight: 0.9 },
  { at: BEATS.sales + 0.8, weight: 0.9 },
  { at: BEATS.schedule + 0.8, weight: 0.9 },
  { at: BEATS.telemetry + 0.8, weight: 0.7 },
  { at: BEATS.payoff, weight: 1 },
]
