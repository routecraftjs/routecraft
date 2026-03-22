import { Text } from "ink";

/**
 * Braille layout: 1 bucket per character, both columns.
 *
 *   Left  Right
 *   0x01  0x08   sub-row 0 (top)
 *   0x02  0x10   sub-row 1
 *   0x04  0x20   sub-row 2
 *   0x40  0x80   sub-row 3 (bottom)
 *
 * Each terminal character represents 1 time bucket.
 * Both columns mirror the same data for btop-style dot density.
 * Each terminal row packs up to 4 step levels vertically.
 */
const BRAILLE_DOTS = [
  0x40 | 0x80,
  0x04 | 0x20,
  0x02 | 0x10,
  0x01 | 0x08,
] as const; // bottom to top
const BRAILLE_BASE = 0x2800;

export interface DotStep {
  max: number;
  color: string;
}

/** Default 5-step config: gray baseline, green low, yellow mid, red high. */
export const DEFAULT_STEPS: DotStep[] = [
  { max: 0, color: "gray" },
  { max: 10, color: "green" },
  { max: 20, color: "green" },
  { max: 30, color: "yellow" },
  { max: 40, color: "yellow" },
  { max: 50, color: "red" },
];

/**
 * Stacked dot graph using braille characters.
 *
 * 1 bucket = 1 terminal character. Both braille columns mirror the same
 * data for btop-style dot density. Each character can stack up to 4 step
 * levels vertically.
 *
 * - 0 exchanges: gray baseline dot (bottom)
 * - 1-9 exchanges: green dot (bottom)
 * - 10-19 exchanges: two green dots stacked
 * - etc., stacking upward with per-level colors
 */
export function DotGraph({
  values,
  columns,
  steps = DEFAULT_STEPS,
  label,
}: {
  values: number[];
  columns: number;
  steps?: DotStep[];
  label?: string;
}) {
  const dotHeight = steps.length - 1;

  // Right-align: newest on right, pad left with zeros
  const data =
    values.length >= columns
      ? values.slice(values.length - columns)
      : [
          ...(new Array(columns - values.length).fill(0) as number[]),
          ...values,
        ];

  // Map each value to a step index (0 = baseline, 1..dotHeight)
  const heights = data.map((v) => {
    if (v <= 0) return 0;
    for (let i = 1; i < steps.length; i++) {
      if (v < steps[i]!.max) return i;
    }
    return dotHeight;
  });

  const termRows = Math.ceil(dotHeight / 4);

  // Build terminal rows from top to bottom
  const rows: JSX.Element[] = [];
  for (let tr = termRows - 1; tr >= 0; tr--) {
    const baseStep = tr * 4;

    // For each bucket, compute the braille bits and color for this terminal row
    const segments: { text: string; color: string }[] = [];

    for (let ci = 0; ci < data.length; ci++) {
      const h = heights[ci]!;
      let bits = 0;
      let color = "";

      for (let sr = 0; sr < 4; sr++) {
        const stepLevel = baseStep + sr + 1;
        if (stepLevel > dotHeight) break;

        // Show dot if height reaches this level, or baseline dot for zero values
        const on = h >= stepLevel || (h === 0 && stepLevel === 1);
        if (on) {
          bits |= BRAILLE_DOTS[sr]!;
          // Color: gray for baseline (zero), step color for data
          color = h === 0 ? steps[0]!.color : steps[stepLevel]!.color;
        }
      }

      const char = String.fromCharCode(BRAILLE_BASE + bits);
      const last = segments[segments.length - 1];
      if (last && last.color === color) {
        last.text += char;
      } else {
        segments.push({ text: char, color });
      }
    }

    rows.push(
      <Text key={tr}>
        {segments.map((s, i) =>
          s.color ? (
            <Text key={i} color={s.color}>
              {s.text}
            </Text>
          ) : (
            <Text key={i}>{s.text}</Text>
          ),
        )}
      </Text>,
    );
  }

  return (
    <>
      {rows}
      {label && <Text dimColor>{label}</Text>}
    </>
  );
}
