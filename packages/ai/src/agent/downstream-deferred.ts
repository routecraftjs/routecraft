import { deferredSchema } from "@routecraft/routecraft";

/**
 * Recognise a downstream acknowledgment before it enters a model or inbox.
 * The schema accepts both in-process brands and JSON transport results.
 * @internal
 */
export function isDownstreamDeferred(value: unknown): boolean {
  const result = deferredSchema["~standard"].validate(value);
  // This framework schema is synchronous; never interpret a pending
  // validator as a successful result if its implementation changes.
  return !("then" in result) && result.issues === undefined;
}
