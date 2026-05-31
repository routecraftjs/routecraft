# Routecraft post templates

Self-contained HTML templates for in-feed social posts. Two formats:

- **Portrait 1080×1350 (4:5)** — LinkedIn's preferred aspect, takes the
  most feed real estate. Best for headlines, quotes, numbered lists.
- **Square 1200×1200 (1:1)** — versatile across LinkedIn / X / Instagram.
  Best for code-heavy or two-column comparison posts; can be cropped
  down to portrait later if a specific post needs it.
- **LinkedIn company banner 1128×191** — the cover image on the
  Routecraft company page. Editorial masthead, not an in-feed post.

Each file renders a frame that matches the Routecraft brand language
(paper / ink / cobalt palette, Fraunces editorial display, JetBrains
Mono technical voice). Open one in a browser, edit the marked sections
in the HTML source, screenshot the frame, post.

## Reference

The brand book moved out of this folder. It is a kept artifact, not a post
template. See [`brand/`](../../../brand/) at the repo root (open
`brand/index.html`). Read it before designing anything else.

## Gallery

Open [`index.html`](./index.html) for a live preview grid of every template,
each shown at true LinkedIn-feed scale so you can sanity-check legibility
before posting. It has a light/dark toggle and a feed/large size toggle. See
[Exporting to image](#exporting-to-image) for how to run it and capture a frame.

## Light and dark

Every template ships both a light and a dark variant from the same file. The
palette is driven by CSS variables (`:root` for light, `.dark` for dark), so a
single class flip retones the whole frame. Pick a variant one of two ways:

- Append `?theme=dark` (or `?theme=light`) to the file URL. This is what the
  gallery's toggle does, and it is the easiest way to screenshot both.
- Add `class="dark"` to the `<html>` tag by hand.

Light is the default. The dark variant brightens the cobalt accent so it holds
contrast on the dark paper.

## Type scale

The type is sized for legibility once LinkedIn shrinks a 1080px-wide portrait to
roughly 360px on a phone (about a third of the canvas). Each template's Tailwind
config defines a role-named scale (`text-eyebrow`, `text-fine`, `text-body`,
`text-body-lg`, `text-lead`, `text-code`, `text-code-lg`, `text-title`,
`text-display`, `text-mega`). Size text by its role, not a pixel value, and the
whole system retunes from that one block. Bigger type means less fits: prefer
fewer words and shorter code snippets (<= 6 lines) over shrinking the font.

## Templates

| File                                | Size      | Use for                                                                                                                                                                                                                               |
| ----------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-text-image-portrait.html`       | 1080×1350 | Announcement / hero. Big headline, body, image slot below.                                                                                                                                                                            |
| `02-code-feature-square.html`       | 1200×1200 | A single capability showcase. Filename header, line-numbered code, trigger-pill footer.                                                                                                                                               |
| `03-text-code-square.html`          | 1200×1200 | Explain a feature. Short copy on the left, code snippet on the right.                                                                                                                                                                 |
| `04-quote-portrait.html`            | 1080×1350 | Pull quote / thought-leadership. Big centered editorial blockquote.                                                                                                                                                                   |
| `05-numbered-list-portrait.html`    | 1080×1350 | Numbered editorial list (01 / 02 / 03 ...). Tips, reasons, principles.                                                                                                                                                                |
| `06-comparison-square.html`         | 1200×1200 | Before / after, or this-vs-that. Two-column code-led compare.                                                                                                                                                                         |
| `07-adapter-announce-square.html`   | 1200×1200 | A new adapter shipped. Mono adapter name as the centrepiece + a usage snippet.                                                                                                                                                        |
| `08-version-announce-portrait.html` | 1080×1350 | A new version shipped. Huge mono version number + 3-4 highlight bullets.                                                                                                                                                              |
| `09-github-stars-portrait.html`     | 1080×1350 | GitHub milestone. ★ icon + big number + thank-you line.                                                                                                                                                                               |
| `10-customer-portrait.html`         | 1080×1350 | A company now using Routecraft in production. Big company name, quote, small stats.                                                                                                                                                   |
| `11-sponsor-portrait.html`          | 1080×1350 | Sponsor / backer announcement, tier-aware (Platinum / Gold / Silver / Bronze / Community).                                                                                                                                            |
| `12-blog-post-portrait.html`        | 1080×1350 | New blog post dropped. Title, excerpt, tags, author, "Read the post" CTA.                                                                                                                                                             |
| `13-video-feature-portrait.html`    | 1080×1350 | Featured on someone's YouTube / podcast. Host name, video title, thumbnail slot, play overlay.                                                                                                                                        |
| `14-incident-callout-portrait.html` | 1080×1350 | News-jack a public LLM/agent production incident. Eyebrow + date, incident headline, factual summary, source attribution, hairline, bounded-capability code snippet as the Routecraft alternative. Use carefully (see notes inside).  |
| `15-linkedin-company-banner.html`   | 1128×191  | LinkedIn company page cover image. Editorial masthead: brand lockup top-left, italic cobalt-accented tagline right-aligned (avoids the avatar overlap zone), URL stamp bottom-right. Avatar safe-zone guide built in (toggle in CSS). |
| `16-versus-portrait.html`           | 1080×1350 | Head-to-head comparison that leads to a blog post. Competitor logo slot + name vs the Routecraft lockup, big italic "vs" divider, one-line positioning each, "Read the comparison" CTA.                                               |
| `17-event-portrait.html`            | 1080×1350 | Event / meetup where Routecraft is covered. Status pill, event name, talk line, When / Where / Speaker detail rows, "Save your seat" CTA.                                                                                             |
| `18-collab-portrait.html`           | 1080×1350 | Collaboration / partnership. Routecraft mark + partner logo slot joined by a cobalt connector (swap `+` for `×` or `♥`), "now works with" headline, link CTA. Leads to a blog or partner page.                                        |
| `19-scaffold-square.html`           | 1200×1200 | Scaffold a project in one command. Terminal chrome with the `bunx create-routecraft … -e <template>` one-liner, then the top features the starter gives you.                                                                          |

## Exporting to image

Pick whichever is easier:

For the dark variant, add `?theme=dark` to the file URL before capturing.

**Chrome devtools (fastest)**

1. Open the HTML in Chrome (append `?theme=dark` for the dark variant).
2. Devtools → ⋮ → More tools → Capture node screenshot.
3. Right-click the outer `.frame` div → Capture node screenshot.
4. PNG saves at the exact frame size.

**Playwright / headless screenshot (scriptable)**

```bash
# Portrait
bunx playwright screenshot --viewport-size 1080,1350 \
  file://$PWD/apps/routecraft.dev/post-templates/01-text-image-portrait.html \
  ./out/01.png

# Square
bunx playwright screenshot --viewport-size 1200,1200 \
  file://$PWD/apps/routecraft.dev/post-templates/02-code-feature-square.html \
  ./out/02.png

# Dark variant (note the ?theme=dark query)
bunx playwright screenshot --viewport-size 1080,1350 \
  "file://$PWD/apps/routecraft.dev/post-templates/01-text-image-portrait.html?theme=dark" \
  ./out/01-dark.png

# LinkedIn company banner
bunx playwright screenshot --viewport-size 1128,191 \
  file://$PWD/apps/routecraft.dev/post-templates/15-linkedin-company-banner.html \
  ./out/15-banner.png
```

**macOS screenshot tool**

1. Open in a browser, resize window so the frame is fully visible.
2. `Cmd+Shift+4`, drag across the frame.
3. The capture comes out at 2× retina (e.g. 2160×2700) — fine, LinkedIn downsamples.

## Editing

Each template has `<!-- EDIT: ... -->` markers around the content you
swap (headline, body copy, code, image source, URL). The Tailwind
config in each file already names the routecraft palette, fonts, and the
role-based [type scale](#type-scale). Use colour tokens (`bg-paper`,
`text-ink`, `text-cobalt-500`) and size tokens (`text-body`, `text-code`, ...)
rather than hard-coded values so both themes and the legibility scale keep
working. Don't touch the outer `.frame` div unless you want to change the
aspect ratio.

## Notes

- Safe zone for important text: keep critical content within the
  centred ~90% region. LinkedIn and X may slightly crop the outer
  edges on smaller previews.
- Use JPG or PNG when exporting. Stay under ~500 KB and you're fine.
- This folder is intentionally outside `src/app/` and `public/` so the
  templates are not routable and won't ship to production.
