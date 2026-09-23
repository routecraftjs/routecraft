/**
 * Whether the process is running a named development or test environment.
 *
 * Deliberately an allowlist rather than `NODE_ENV !== "production"`: an
 * unset `NODE_ENV` is the most common production misconfiguration, and
 * under the negated form it would silently relax a production guard on a
 * real deployment. Per `.standards/security.md` section 6a, the relaxed
 * mode is the one that has to be named. Shared with `@routecraft/ai`, whose
 * MCP resource guard follows the same rule.
 *
 * @internal
 */
export function isDevelopmentRuntime(): boolean {
  const env = process.env["NODE_ENV"];
  return env === "development" || env === "test";
}
