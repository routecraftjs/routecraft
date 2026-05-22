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
 *
 * @beta
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
  // Node phrasings observed in the wild:
  //   ESM: `Cannot find package 'pkg' imported from /path`
  //   ESM bare: `Cannot find module '/abs/path/pkg/index.js' imported from ...`
  //   CJS: `Cannot find module 'pkg'`
  // Match the package name surrounded by quotes so we do not mistake
  // a transitive-dep miss inside the same package for a missing peer.
  return (
    message.includes(`'${packageName}'`) || message.includes(`"${packageName}"`)
  );
}
