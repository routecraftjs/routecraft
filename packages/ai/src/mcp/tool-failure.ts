import {
  isOutputValidationFailure,
  rcCodeOf,
  wireIssues,
  type CallerRefusal,
  type WireIssues,
} from "@routecraft/routecraft";

/**
 * The text a failed local tool call answers with.
 *
 * MCP clients are usually LLM agents that correct themselves from the
 * answer, so a failure the caller caused on this tool's own route keeps a
 * reason it can act on: the schema issues of an `.input()` refusal, or the
 * class of an `authorize()` refusal. Which failures those are is decided by
 * `callerRefusalOf`, the classification every door shares.
 *
 * A body that broke the tool's declared output schema names the failing
 * fields too. That schema is published as the tool's `outputSchema`, so its
 * paths and messages tell the caller nothing `tools/list` did not. The
 * output headers schema is never published, so its issues stay off the wire.
 *
 * Everything else answers with the tool name and the error code only. An
 * error message routinely interpolates its cause, and the cause of a route
 * failure is whatever its steps threw: hostnames, file paths, upstream
 * response text, the route id. The message goes to the log and the
 * `plugin:mcp:tool:failed` event, never to the caller.
 *
 * @param tool - The tool the caller named
 * @param error - What the call threw
 * @param refusal - What `callerRefusalOf` made of the error, classified once
 *   by the caller so the log level and this text cannot disagree
 * @param routeId - The tool's route
 * @returns The tool result text, without the `Error: ` prefix
 */
export function toolFailureText(
  tool: string,
  error: unknown,
  refusal: CallerRefusal | undefined,
  routeId: string,
): string {
  if (refusal !== undefined) return refusalText(tool, refusal);
  const code = rcCodeOf(error);
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (
    code !== undefined &&
    isOutputValidationFailure(cause) &&
    cause.invalidOutput.in === "body" &&
    cause.invalidOutput.routeId === routeId
  ) {
    return `MCP tool "${tool}" returned a body that does not match its declared output schema (${code})${issuesText(wireIssues(cause.invalidOutput.issues))}`;
  }
  return code === undefined
    ? `Tool "${tool}" failed.`
    : `Tool "${tool}" failed (${code}).`;
}

function refusalText(tool: string, refusal: CallerRefusal): string {
  switch (refusal.kind) {
    case "input": {
      const part =
        refusal.in === "body" ? "its arguments" : "the request headers";
      return `Tool "${tool}" rejected ${part} (RC5065)${issuesText(refusal)}`;
    }
    case "unauthenticated":
      return `Tool "${tool}" requires an authenticated caller. Connect with a credential and retry.`;
    case "expired":
      return `Tool "${tool}" refused the call: the credential expired. Refresh it and retry.`;
    case "insufficient_permissions":
      return `Tool "${tool}" refused the call: insufficient permissions.`;
    case "insufficient_scope": {
      if (refusal.scopes.length === 0) {
        return `Tool "${tool}" refused the call: insufficient scope.`;
      }
      const scopes = refusal.scopes.join(", ");
      return refusal.anyOf
        ? `Tool "${tool}" refused the call: insufficient scope, requires one of: ${scopes}.`
        : `Tool "${tool}" refused the call: insufficient scope, missing: ${scopes}.`;
    }
  }
}

/** `": "` then each issue as `"path": message`, the left-out ones counted. */
function issuesText({ issues, omitted }: WireIssues): string {
  if (issues.length === 0) return ".";
  const listed = issues.map((issue) =>
    issue.path === undefined
      ? issue.message
      : `"${issue.path}": ${issue.message}`,
  );
  if (omitted > 0) listed.push(`and ${String(omitted)} more`);
  return `: ${listed.join("; ")}`;
}
