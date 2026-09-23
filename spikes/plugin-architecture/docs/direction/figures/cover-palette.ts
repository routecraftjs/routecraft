/**
 * Mirror of the site's `CoverPalette` (`apps/routecraft.dev/app/components/BlogCover.tsx`),
 * so a motif authored here is a drop-in for the site's figure system.
 */
export interface CoverPalette {
  bg: string;
  fg: string;
  accent: string;
  muted25: string;
  muted40: string;
  muted55: string;
  muted62: string;
}

export const COVER_PALETTE_LIGHT: CoverPalette = {
  bg: "#ebe5da",
  fg: "#22232c",
  accent: "#1247ff",
  muted25: "rgba(34,35,44,0.25)",
  muted40: "rgba(34,35,44,0.40)",
  muted55: "rgba(34,35,44,0.55)",
  muted62: "rgba(34,35,44,0.62)",
};
