# The platform film

The homepage film is code, not a video file. `app/components/film/FilmFrame.tsx`
draws any moment of the film as a pure function of time on a 1920x1080 canvas,
and everything else reads the same clock.

| Piece    | Where                                  | What it does                                                                                                      |
| -------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Timeline | `app/components/film/timeline.ts`      | The film as data: captions, narration windows, card positions, score events, and the easing and blending helpers. |
| Frame    | `app/components/film/FilmFrame.tsx`    | Draws one moment. Every position, size and fade is computed from `t`.                                             |
| Player   | `app/components/film/HeroFilm.tsx`     | Plays it muted in the homepage hero; a click opens it in a lightbox with voice and music. With sound on, the audio element is the clock. |
| Scripts  | `scripts/film/`                        | Music, voice, mix and the MP4 export. Run by hand, never by the build.                                            |

## How a move works

An element has two or more resting rectangles. Between two moments in the
timeline, `mixRect` blends position and size from one to the next through an
ease-in-out curve; `span` fades an element in, holds it and fades it out. A
"focus, then shrink to a slot" move is one `mixRect` between a centre-stage
rectangle and a slot rectangle.

## Making the next film

Copy the three component files and the scripts, then redraw. Duplication
between films is accepted: each film is mostly one-off, and the previous one is
the reference for the next.

## Regenerating the media

ffmpeg must be on `PATH` or set in `FFMPEG`.

```
bun scripts/film/score.ts                 # music stem
bun add --no-save kokoro-js               # the voice model runtime, 427 MB, not a dependency
bun scripts/film/voice.ts                 # voice stem, VOICE=bm_george for another voice
bun scripts/film/mix.ts                   # public/film/soundtrack.mp3
bun scripts/film/render.ts                # public/film/routecraft-platform.mp4
bun scripts/film/render.ts --stills 12,44 # review PNGs instead of the MP4
```

## Why no animation framework

Remotion is the product built on this same model (React scenes driven by a
frame number, a live player and an MP4 export) and is the first place to look
if films start coming in batches from one design. Until then it would replace a
few hundred working lines with a dependency and, above a small company size, a paid licence.
GSAP, Framer Motion and CSS animations run on their own clocks, which makes
frame-exact export and sync to narration harder.
