import {
  formatSchemaIssues,
  rcError,
  type CraftContext,
} from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ADAPTER_FN_REGISTRY } from "./store.ts";
import type { FnHandlerContext, FnOptions, RegisteredFnId } from "./types.ts";

/**
 * Validate `input` against the fn's Standard Schema. Throws RC5002 on
 * failure with the issues formatted into the message.
 */
async function validateInput<TIn>(
  id: string,
  schema: StandardSchemaV1<TIn>,
  input: unknown,
): Promise<TIn> {
  const standard = (schema as unknown as Record<string, unknown>)[
    "~standard"
  ] as
    | {
        validate: (
          value: unknown,
        ) =>
          | { value?: unknown; issues?: unknown }
          | Promise<{ value?: unknown; issues?: unknown }>;
      }
    | undefined;
  if (!standard?.validate) {
    throw rcError("RC5003", undefined, {
      message: `fn "${id}": schema is not a Standard Schema.`,
    });
  }
  let result = standard.validate(input);
  if (result instanceof Promise) result = await result;
  if (result.issues !== undefined && result.issues !== null) {
    throw rcError("RC5002", undefined, {
      message: `fn "${id}": input validation failed: ${formatSchemaIssues(result.issues)}`,
    });
  }
  return result.value as TIn;
}

/** Options for `invokeFn`. */
export interface InvokeFnOptions {
  /**
   * Optional abort signal forwarded to the fn handler via
   * `FnHandlerContext.abortSignal`. Defaults to a never-firing signal
   * when omitted.
   */
  signal?: AbortSignal;
}

/**
 * Look up a registered fn by id and invoke its handler with
 * schema-validated input and a minimal handler context.
 *
 * Errors:
 *
 * - **RC5004** -- no fn registry in the context (agentPlugin not
 *   installed) or the id is not registered.
 * - **RC5002** -- input fails the fn's schema.
 * - **RC5003** -- the registered schema is not a valid Standard Schema.
 *
 * Provider or user-code errors thrown from the handler propagate as-is.
 *
 * @experimental
 *
 * @example
 * ```typescript
 * import { invokeFn } from "@routecraft/ai";
 *
 * const iso = await invokeFn(context, "currentTime", {});
 * ```
 */
export async function invokeFn<TIn = unknown, TOut = unknown>(
  context: CraftContext,
  id: RegisteredFnId,
  input: TIn,
  options: InvokeFnOptions = {},
): Promise<TOut> {
  const registry = context.getStore(
    ADAPTER_FN_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
  ) as Map<string, FnOptions> | undefined;
  if (!registry) {
    throw rcError("RC5004", undefined, {
      message:
        `fn "${String(id)}" not found: no fns registered. ` +
        `Add agentPlugin({ functions: { "${String(id)}": {...} } }) to your config.`,
    });
  }
  const fnOptions = registry.get(String(id));
  if (!fnOptions) {
    const known = Array.from(registry.keys()).join(", ") || "<none>";
    throw rcError("RC5004", undefined, {
      message: `fn "${String(id)}" not found in registry. Known fns: ${known}.`,
    });
  }

  const validated = await validateInput(String(id), fnOptions.schema, input);

  const handlerCtx: FnHandlerContext = {
    logger: context.logger.child({ fn: String(id) }),
    abortSignal: options.signal ?? new AbortController().signal,
    context,
  };

  return (await fnOptions.handler(validated, handlerCtx)) as TOut;
}
