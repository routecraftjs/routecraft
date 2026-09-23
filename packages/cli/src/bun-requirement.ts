/**
 * What the craft CLI tells someone who runs it without Bun.
 *
 * Kept apart from `runtime-gate.ts` because the entry point checks for Bun
 * before anything else, and that check must not load core: `runtime-gate.ts`
 * reads the version with core's parser, and loading core builds the logger.
 */

export const INSTALL_URL = "https://bun.com/docs/installation";

export const EMBEDDING_DOC_URL =
  "https://routecraft.dev/docs/advanced/programmatic-invocation";

export const MISSING_BUN_MESSAGE =
  `[routecraft] The craft CLI requires Bun. ` +
  `Install Bun from ${INSTALL_URL}, ` +
  `or embed @routecraft/routecraft programmatically (see ${EMBEDDING_DOC_URL}).`;
