import type { McpIcon } from "./types.ts";

/**
 * The Routecraft logo as an inline SVG, parameterised by fill colour so we can
 * emit a light-theme (dark logo) and dark-theme (light logo) variant from one
 * source. Geometry is taken from `routecraft.svg` at the repo root.
 */
const logoSvg = (fill: string): string =>
  `<svg width="200" height="200" viewBox="0 0 200 200" fill="${fill}" xmlns="http://www.w3.org/2000/svg"><path d="M125 175H75V125L125 175ZM175 175H125V125L175 175ZM125 25C152.614 25 175 47.3858 175 75C175 102.614 152.614 125 125 125V75H75L125 125H75L25 75V25H125Z" /></svg>`;

/**
 * The same mark rasterised to a 96x96 PNG, one constant per fill. 96x96 covers
 * the ~48px slot a connector list gives an icon at 2x density.
 *
 * Rasterised from `logoSvg` above with resvg at width 96. Regenerate both when
 * that geometry changes; nothing checks that they still agree.
 */
const logoPngWhiteBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAEg0lEQVR4nO2c4XHTQBCFd0ugA+gAOqAE0sG5BDrAHUAFmA5CB9BB0oHowFRwfJeMwQTH0Z5udWey38ybzQ/lae+9RCiBQSXoShTQmSigM1FAZ6KAzkQBnYkCOhMFdCYK6EwU0JkooDNRQGfMBWRg/A9Mcq9vcj+/quqeuSrPuYBT3KCdiHzRlcqIAk5Twt+JyCeKmMSRKOA8pYiPlLBluqDIBPk/pwIO3KAripikMVHAfPboPSXspCFRgJ2NNiwhCqhjo41KiALquaKEa+YiooB69ugNJUyygChgGTcU8IZZTRSwnK2qfpBKooDlLHoURQFt2Grld0EU0IbyXfBKK36BFwW0Y6MVPxtEAe2oeiOKAtryghJMj6EooC1XFHDNnE0U0JatGt+GooC2fFfVt2IgCmjLRAGvmLNRZIL8o4AzUIApU9PFBfKPAs5A/qZMTRcXyD+JyGfkxY4zbJgusH9muMHuypiN6eIDnCHJhZbA7pnhBnsrYzami4/hHEkusAT2zgwvfqjqSzGgqBrOkuTCSmDnzPDiu3q/hj6E8yS5oBLYNzO82Kr3D2Kn4ExJLqQEds0ML/x/FfEYnCvJBZTAnpnhxQt23DNno6gZnC3J4CWwY2Z4cMtur5kmFDWF8yUZuAT2ywwPNrrGX8jMgTMmGbQEdsuM1vxEL9lpzzShyAXOmWTAEtgrM1qzVePbzwFFbnDWJIOVwE6Z0ZLy1f+aPSapQJErnDfJQCWwT2a0ZKuVX/0FRe5w5iSDlMAumdGKqjefYxStAudOMkAJ7JEZLVj06DmgaDU4e5LOJbBDZrTgintdMxehaFU4f5KOJXD/zFjKRive+U+haHXIIEmnErh3Zixho43CLyjqAjkk6VAC982MGsozP+G5+LFzjKJukEWSlUvgnplh5Ra9w2uSxijqCnkkWbEE7pcZc/mJPvL5H8QJRd0hkyQrlcC9MuMp7oJH5fMmcUTREJBLkhVK4D6Zjx/jFpXgr7l2z3RnmAIKZJPEuQThD1K55wea5P6/q7lB39YK/RhFQ0EJnwliw4cuePtbUTQUBJQZO6+QsHf1t6JoKMinBFRwCQl7V38rioaCfA4BFZqHhL2rvxVFQ0E+xwEVmoaEvau/FUVDQT4PAyo0Cwl7V38rioaCfE4FVGgSEvau/lYUDQX5PBZQYXFI2Lv6W1E0FORzLqDCopCwd/W3omgoyOepgArVIWHv6m9F0VCQz5yAClUhYe/qb0XRUJDP3IAK5pCwd/W3omgoyMcSUMEUEvau/lYUDQX5WAMqzA4Je1d/K4qGgnxqAirMCgl7V38rioaCfGoDKjwZEvau/lYUDQX5LAmocDYk7F39rSgaCvJZGlDh0ZCwd/W3omgoyKdFQIWTIWHv6m9F0VCQT6uACv+EhL2rvxVFQ0E+LQMq/BUS9q7+VhQNBfm0DqjwOyTsXf2tKBoK8vEIqHAXEvau/kwTioaCfLwCKuzkz78L8sBcgqKgI1FAZ6KAzkQBnYkCOhMFdCYK6EwU0JkooDNRQGeigM5EAZ35BUdeZn9omdUvAAAAAElFTkSuQmCC";
const logoPngBlackBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAD50lEQVR4nO3c7XFTSRCF4dMhkAGbAZsBIawzGIewGUgZsBHskIHJADKQMxAZyBEMp0u4ECDJt++dvtPC/VS9xR/XFNXHNh9FIUhD5QCD5QCD5QCD5QCD5QCD5QCD5QCD5QCD5QCD5QCD5QCDzRmgsT/BHsc+4/jjJ3Zgq3rNA5yzYxXAR3Zg7oRZ/ckDPNPjVwD/sT0c5QDX6RAf2Ja5EGb1mgZ4tmN3bI/OcoDpDuxfVtFRDmB3zyo6EWb12gdQ96yiA2FWOcDRHXtgi+QA8x3Y32yPBXKAZXZMR5gtB1huyzaYSZhVDvCzA9Ovgj1myAH62LINZhBmlQP8Tr8K/mL6o4kwqxzgvHtWYSTMKgc4b8f01wKTHKCvN+zAJssB+rpjD2yyHKCvLdvAQJhVDnDZF/YeBsKscoDL9jj+dnQyYVY5wHWmm5o++Lsc4DrTTU0f/F0B8D/zUnH8Q42XxjwJm8z0wScKbneExjwJm8z0wb8ouM0RGvPylb2FgbAlCm5vhMa8fGHvYSBsqYLbGqExL1u2gYGwHgpuZ4TGvKzyVxGXFNzGCI15ecMObDJhPRXEH6ExD4/sHTMR1ltB7BEa86A/pwojYR4K4o7QWG9P7C2M336UMC8FMUdorLct22AGYZ4K4o3QWE/62f+O7TGDMG8FsUZorKct22AmYWsoiDNCY708Mv3sn03YWgpijNBYD09Mj7/HAsLWVDB+hMZ6uGMPbBFhaysYO0JjS+n7FR0IG6Fg3AiNLaHvVnQibJSCMSM0NscTK+jwbeeUsJEK1h+hMatH9g/bozNhoxWsO0JjUz2xD2wDJ8IiKFhvhMZe8nz4CofP+lPCoihYZ4TGLnlkevgHdmDuhEVS4D9CwdFXtsfxv6vZsc9Y6einhEWjA9wzL97vmwiLprEKvyN5v28iLBo9kKrwOZL3+ybConk+kKrofyTv902ERXN6IFXR90je75sIi+bXA6mKfkfyft9EWDTnDqQq+hzJ+30TYdFcOpCqWH4k7/dNhEVz7UCqYtmRvN83ERbNSwdSFfOP5P2+ibBophxIVcw7kvf7JsKimXogVWE/kvf7JsKisRxIVdiO5P2+ibBorAdSFdOP5P2+ibBo5hxIVUw7kvf7JsKimXsgVfHykbzfNxEWzZIDqYrrR/J+30RYNEsPpCouH8n7fRNh0fQ4kKo4fyTv902ERdPrQKri9yN5v28iLJqeB1IVPx/J+30TYdH0PpCq+HEk7/dNhEXjcSBVcTyS9/smwqLxOpCq+PHvgjxUGEcQlgbKAQbLAQbLAQbLAQbLAQbLAQbLAQbLAQbLAQbLAQbLAQb7BkawBHCF2YCbAAAAAElFTkSuQmCC";

const toSvgDataUri = (svg: string): string =>
  `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;

const toPngDataUri = (base64: string): string =>
  `data:image/png;base64,${base64}`;

/**
 * Deep-freeze one icon. `Object.freeze` is shallow, so `sizes` would otherwise
 * stay mutable inside the frozen shared constant and one stray `push` would
 * corrupt the advertised icons for every server and tool in the process.
 */
const frozenIcon = (icon: McpIcon): McpIcon =>
  Object.freeze({
    ...icon,
    ...(icon.sizes ? { sizes: Object.freeze(icon.sizes) as string[] } : {}),
  }) as McpIcon;

/**
 * Default Routecraft branding for `serverInfo.icons` when a consumer does not
 * set their own, inherited by every tool that declares none of its own.
 *
 * Four entries: the mark in white for dark client themes and black for light
 * ones, each offered as a PNG and an SVG so a client can take a format it
 * accepts. The PNG leads each pair because it is the format clients must
 * support, so a client picking the first entry it understands still renders.
 *
 * These stay inline as `data:` URIs rather than URLs on routecraft.dev on
 * purpose: a consumer must verify that an icon URI is same-origin with the
 * server it came from, so a routecraft.dev URL on a deployment running
 * anywhere else is precisely what a conforming client is told to reject.
 */
// Frozen because this single array is handed out by reference to every server's
// serverInfo and every inheriting tool; freezing prevents an accidental in-place
// mutation from leaking process-wide into the shared default.
export const ROUTECRAFT_DEFAULT_ICONS: McpIcon[] = Object.freeze([
  frozenIcon({
    src: toPngDataUri(logoPngWhiteBase64),
    mimeType: "image/png",
    sizes: ["96x96"],
    theme: "dark",
  }),
  frozenIcon({
    src: toSvgDataUri(logoSvg("#ffffff")),
    mimeType: "image/svg+xml",
    sizes: ["any"],
    theme: "dark",
  }),
  frozenIcon({
    src: toPngDataUri(logoPngBlackBase64),
    mimeType: "image/png",
    sizes: ["96x96"],
    theme: "light",
  }),
  frozenIcon({
    src: toSvgDataUri(logoSvg("#000000")),
    mimeType: "image/svg+xml",
    sizes: ["any"],
    theme: "light",
  }),
]) as McpIcon[];
