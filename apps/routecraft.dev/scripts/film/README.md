# The platform film

The homepage film is code, not a video file. `app/components/film/FilmFrame.tsx`
draws any moment of the film as a pure function of time on a 1920x1080 canvas,
and everything else reads the same clock.

| Piece    | Where                               | What it does                                                                                                                          |
| -------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Timeline | `app/components/film/timeline.ts`   | The film as data: captions, narration windows, card positions, score events, and the easing and blending helpers.                     |
| Frame    | `app/components/film/FilmFrame.tsx` | Draws one moment. Every position, size and fade is computed from `t`.                                                                 |
| Player   | `app/components/film/HeroFilm.tsx`  | Plays it in the homepage hero; a click opens it in a lightbox. Silent for now: the stems and the mix come back with the reworked cut. |
| Scripts  | `scripts/film/`                     | Music, voice, mix and the MP4 export. Run by hand, never by the build.                                                                |

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

Two voice scripts write the same stem, `scripts/film/audio/voice.mp3`, and
`mix.ts` takes whichever ran last:

| Voice      | Script      | Cost                      | Use it for                                        |
| ---------- | ----------- | ------------------------- | ------------------------------------------------- |
| Draft      | `voice.ts`  | Free, runs locally        | Every review render, until the film is signed off |
| Production | `eleven.ts` | ElevenLabs, per character | The final render only                             |

Judge the script, the picture and the timing on the draft voice; ElevenLabs is
billed per character, so it runs once the cut is approved. `voice.ts` uses
Kokoro with the male voice `bm_george` (`VOICE=` for another). `eleven.ts` uses
Eleven v4 with the film's narrator voice; it reads `ELEVENLABS_API_KEY` from the
environment, and `ELEVENLABS_VOICE_ID` and `ELEVENLABS_MODEL` override the
voice and the model. It reads the script as one take and cuts it at the pauses;
`--lines` reads each line separately. Neither script speeds a production read
up: when a line runs past its window, retime the timeline to the read.

```
bun scripts/film/score.ts                 # music stem
bun add --no-save kokoro-js               # the voice model runtime, 427 MB, not a dependency
bun scripts/film/voice.ts                 # draft voice stem, free, local
bun scripts/film/eleven.ts                # production voice stem, paid, final render only
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

## Shipping state

The site draws the film live and ships one media file,
`public/film/soundtrack.mp3`: the production voice mixed over the music. It is
committed, because the player plays it. Everything else the scripts write
(the stems in `scripts/film/audio/`, the MP4, the stills) is generated and
ignored. Replace the soundtrack only with a production read; a draft-voice mix
is for review and never lands on the page.
