import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

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
