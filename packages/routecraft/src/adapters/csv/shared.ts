import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Dynamically load papaparse and verify it is installed.
 * Throws with installation instructions if not available.
 *
 * @internal Not exported from the package public API.
 */
export function ensurePapaparse(): typeof import("papaparse") {
  try {
    const papa = require("papaparse");
    return papa.default || papa;
  } catch {
    throw new Error(
      "csv adapter requires 'papaparse' to be installed. Install it with: npm install papaparse",
    );
  }
}
