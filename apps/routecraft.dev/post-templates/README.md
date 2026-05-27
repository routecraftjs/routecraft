# Routecraft post templates

Self-contained HTML templates for in-feed social posts. Two formats:

- **Portrait 1080×1350 (4:5)** — LinkedIn's preferred aspect, takes the
  most feed real estate. Best for headlines, quotes, numbered lists.
- **Square 1200×1200 (1:1)** — versatile across LinkedIn / X / Instagram.
  Best for code-heavy or two-column comparison posts; can be cropped
  down to portrait later if a specific post needs it.

Each file renders a frame that matches the Routecraft brand language
(paper / ink / cobalt palette, Fraunces editorial display, JetBrains
Mono technical voice). Open one in a browser, edit the marked sections
in the HTML source, screenshot the frame, post.

## Reference

| File                                  | Size       | Use for |
| ------------------------------------- | ---------- | ------- |
| `00-brand-identity.html`              | 1200×auto  | The brand book. Logo system, colour palette, typography, voice, layout, UI primitives, motifs. Open in a browser, print to PDF if you want a deliverable. Read this before designing anything else. |
| `00b-logo-options.html`               | 1200×auto  | Eight logo concept marks (pipeline, capability cell, italic R, chevron, crosshair, stamped RC, R(), square+arrow). Each shown light, dark, favicon-size, and as a lock-up with the wordmark. Right-click any SVG to copy the markup. |

## Templates

| File                                  | Size       | Use for |
| ------------------------------------- | ---------- | ------- |
| `01-text-image-portrait.html`         | 1080×1350  | Announcement / hero. Big headline, body, image slot below. |
| `02-code-feature-square.html`         | 1200×1200  | A single capability showcase. Filename header, line-numbered code, trigger-pill footer. |
| `03-text-code-square.html`            | 1200×1200  | Explain a feature. Short copy on the left, code snippet on the right. |
| `04-quote-portrait.html`              | 1080×1350  | Pull quote / thought-leadership. Big centered editorial blockquote. |
| `05-numbered-list-portrait.html`      | 1080×1350  | Numbered editorial list (01 / 02 / 03 ...). Tips, reasons, principles. |
| `06-comparison-square.html`           | 1200×1200  | Before / after, or this-vs-that. Two-column code-led compare. |
| `07-adapter-announce-square.html`     | 1200×1200  | A new adapter shipped. Mono adapter name as the centrepiece + a usage snippet. |
| `08-version-announce-portrait.html`   | 1080×1350  | A new version shipped. Huge mono version number + 3-4 highlight bullets. |
| `09-github-stars-portrait.html`       | 1080×1350  | GitHub milestone. ★ icon + big number + thank-you line. |
| `10-customer-portrait.html`           | 1080×1350  | A company now using Routecraft in production. Big company name, quote, small stats. |
| `11-sponsor-portrait.html`            | 1080×1350  | Sponsor / backer announcement, tier-aware (Platinum / Gold / Silver / Bronze / Community). |
| `12-blog-post-portrait.html`          | 1080×1350  | New blog post dropped. Title, excerpt, tags, author, "Read the post" CTA. |
| `13-video-feature-portrait.html`      | 1080×1350  | Featured on someone's YouTube / podcast. Host name, video title, thumbnail slot, play overlay. |
| `14-incident-callout-portrait.html`   | 1080×1350  | News-jack a public LLM/agent production incident. Eyebrow + date, incident headline, factual summary, source attribution, hairline, bounded-capability code snippet as the Routecraft alternative. Use carefully (see notes inside). |

## Exporting to image

Pick whichever is easier:

**Chrome devtools (fastest)**
1. Open the HTML in Chrome.
2. Devtools → ⋮ → More tools → Capture node screenshot.
3. Right-click the outer `.frame` div → Capture node screenshot.
4. PNG saves at the exact frame size.

**Playwright / headless screenshot (scriptable)**

```bash
# Portrait
npx playwright screenshot --viewport-size 1080,1350 \
  file://$PWD/apps/routecraft.dev/post-templates/01-text-image-portrait.html \
  ./out/01.png

# Square
npx playwright screenshot --viewport-size 1200,1200 \
  file://$PWD/apps/routecraft.dev/post-templates/02-code-feature-square.html \
  ./out/02.png
```

**macOS screenshot tool**
1. Open in a browser, resize window so the frame is fully visible.
2. `Cmd+Shift+4`, drag across the frame.
3. The capture comes out at 2× retina (e.g. 2160×2700) — fine, LinkedIn downsamples.

## Editing

Each template has `<!-- EDIT: ... -->` markers around the content you
swap (headline, body copy, code, image source, URL). The Tailwind
config in each file already names the routecraft palette and fonts.
Don't touch the outer `.frame` div unless you want to change the
aspect ratio.

## Notes

- Safe zone for important text: keep critical content within the
  centred ~90% region. LinkedIn and X may slightly crop the outer
  edges on smaller previews.
- Use JPG or PNG when exporting. Stay under ~500 KB and you're fine.
- This folder is intentionally outside `src/app/` and `public/` so the
  templates are not routable and won't ship to production.
