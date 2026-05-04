import { rcError } from "../../error.ts";

/**
 * Dynamically load an optional peer dependency. If the package is not
 * installed, throw a Routecraft error (RC5017) that names the missing
 * package and the install command.
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
    throw rcError("RC5017", cause, {
      message:
        `${ctx.adapterName} adapter requires the optional peer dependency "${ctx.packageName}". ` +
        `Install it: bun add ${ctx.packageName} (or npm install ${ctx.packageName}).`,
    });
  });
}
