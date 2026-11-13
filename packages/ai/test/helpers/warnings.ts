import type { TestContext } from "@routecraft/testing";

/** Collect the warnings a context logs, keeping the bound fields. */
export function captureWarnings(
  t: TestContext,
): Array<{ fields: Record<string, unknown>; message: string }> {
  const warnings: Array<{ fields: Record<string, unknown>; message: string }> =
    [];
  const original = t.ctx.logger.warn.bind(t.ctx.logger);
  t.ctx.logger.warn = ((first: unknown, second?: unknown) => {
    warnings.push(
      typeof first === "string"
        ? { fields: {}, message: first }
        : {
            fields: first as Record<string, unknown>,
            message: String(second),
          },
    );
    return original(first as never, second as never);
  }) as typeof t.ctx.logger.warn;
  return warnings;
}
