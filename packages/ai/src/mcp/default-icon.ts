import type { McpIcon } from "./types.ts";

/**
 * The Routecraft logo as an inline SVG, parameterised by fill colour so we can
 * emit a light-theme (dark logo) and dark-theme (light logo) variant from one
 * source. Geometry is taken from `routecraft.svg` at the repo root.
 */
const logoSvg = (fill: string): string =>
  `<svg width="200" height="200" viewBox="0 0 200 200" fill="${fill}" xmlns="http://www.w3.org/2000/svg"><path d="M125 175H75V125L125 175ZM175 175H125V125L175 175ZM125 25C152.614 25 175 47.3858 175 75C175 102.614 152.614 125 125 125V75H75L125 125H75L25 75V25H125Z" /></svg>`;

const toDataUri = (svg: string): string =>
  `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;

/**
 * Default Routecraft branding for `serverInfo.icons` when a consumer does not
 * set their own. Two variants so the mark stays legible on either client theme:
 * a white logo for dark UIs and a black logo for light UIs.
 */
// Frozen because this single array is handed out by reference to every server's
// serverInfo and every inheriting tool; freezing prevents an accidental in-place
// mutation from leaking process-wide into the shared default.
export const ROUTECRAFT_DEFAULT_ICONS: McpIcon[] = Object.freeze([
  Object.freeze({
    src: toDataUri(logoSvg("#ffffff")),
    mimeType: "image/svg+xml",
    theme: "dark",
  }),
  Object.freeze({
    src: toDataUri(logoSvg("#000000")),
    mimeType: "image/svg+xml",
    theme: "light",
  }),
]) as McpIcon[];
