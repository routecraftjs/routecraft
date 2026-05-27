import type { McpIcon } from "./types.ts";

/**
 * The Routecraft logo as an inline SVG, parameterised by fill colour so we can
 * emit a light-theme (dark logo) and dark-theme (light logo) variant from one
 * source. Geometry is taken from `routecraft.svg` at the repo root.
 */
const logoSvg = (fill: string): string =>
  `<svg width="200" height="200" viewBox="0 0 200 200" fill="${fill}" xmlns="http://www.w3.org/2000/svg"><path d="M125 175L75 125V175H125Z"/><path d="M175 175L125 125V175H175Z"/><path d="M25 75L75 125L75 75L25 75Z"/><path d="M125 125L75 75L75 125H125Z"/><path d="M75 25H125V75L75 75L75 25Z"/><path d="M25 25H75L75 75L25 75L25 25Z"/><path d="M125 125C152.614 125 175 102.614 175 75C175 47.3858 152.614 25 125 25V75V125Z"/></svg>`;

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
