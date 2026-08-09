import { rcError } from "../../error.ts";

/**
 * Dynamically load an optional peer dependency. If the package is not
 * installed, throw a Routecraft error (RC5017) that names the missing
 * package and the install command. Other failures (an installed package
 * that throws during initialisation, ESM/CJS interop bugs, native binding
 * crashes) are rethrown unchanged so the surface message is not a
 * misleading "install &lt;pkg&gt;" suggestion.
 *
 * Use this in adapters whose underlying drivers are declared as optional
 * peer dependencies in `@routecraft/routecraft`. Pass a thunk like
 * `() => import("croner")` so the bundler sees the literal package name
 * and can keep it external.
 *
 * @param loader - Thunk that performs the dynamic `import("...")` call.
 * @param ctx - Names used in the error message: the adapter (`cron`,
 *              `html`, ...) and the missing package.
 */
export function loadOptionalPeer<T>(
  loader: () => Promise<T>,
  ctx: { adapterName: string; packageName: string },
): Promise<T> {
  // Use a sync .catch() chain (rather than `async/await`) so the caller's
  // `await loadOptionalPeer(...)` only adds one microtask hop. Two hops
  // tripped fake-timer based cron tests where advanceTimersByTimeAsync(0)
  // only flushes a single cycle of microtasks.
  return loader().catch((cause: unknown) => {
    if (!isMissingExpectedPackage(cause, ctx.packageName)) {
      // Either an unrelated error code, or `ERR_MODULE_NOT_FOUND` for a
      // *different* package than the one we tried to load (i.e. the peer
      // is installed but imports a missing transitive dep). Rethrow so
      // the user sees the real failure rather than a misleading "install
      // <our peer>" hint.
      throw cause;
    }
    throw rcError("RC5017", cause, {
      message:
        `${ctx.adapterName} adapter requires the optional peer dependency "${ctx.packageName}". ` +
        `Install it: bun add ${ctx.packageName} (or npm install ${ctx.packageName}).`,
    });
  });
}

function isMissingExpectedPackage(
  cause: unknown,
  packageName: string,
): boolean {
  if (cause === null || typeof cause !== "object") return false;
  const code = (cause as { code?: unknown }).code;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") {
    return false;
  }
  const message = (cause as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  // Phrasings observed in the wild:
  //   Node ESM:  `Cannot find package 'pkg' imported from /path`
  //   CJS:       `Cannot find module 'pkg'`
  //   Bun:       `Cannot find module 'pkg/subpath' from '/path'`
  // Node names the package even when the import used a subpath; Bun quotes the
  // full specifier. Accept the quoted name with an optional subpath suffix so a
  // subpath loader (`pkg/stdio`) still yields RC5017 on Bun instead of a raw
  // ERR_MODULE_NOT_FOUND. The quote-or-slash boundary keeps this from matching
  // a longer package name that merely starts with the same characters, and the
  // opening quote keeps a transitive-dep miss inside the same package from
  // being mistaken for the peer itself. The resolved-path phrasing
  // (`Cannot find module '/abs/path/pkg/index.js'`) is deliberately NOT
  // matched: it means the package resolved but its entry file is missing,
  // which is a broken install rather than an absent peer, and an install hint
  // would send the user down the wrong path.
  return QUOTES.some((quote) => {
    const start = message.indexOf(`${quote}${packageName}`);
    if (start === -1) return false;
    const next = message[start + quote.length + packageName.length];
    return next === quote || next === "/";
  });
}

/** Quote characters a runtime may wrap a specifier in. */
const QUOTES = ["'", '"'] as const;
