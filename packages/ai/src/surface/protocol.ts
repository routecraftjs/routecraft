/**
 * The protocol's own shapes, checked at the surface boundary.
 *
 * An editor is outside the trust boundary: a separate process on the
 * person's machine, any program claiming to be one, at any version of the
 * protocol. Every other external input to a route is parsed before use,
 * and what an editor answers is no exception. The shapes are not restated
 * here: the SDK ships the protocol's generated JSON Schema, and the
 * validators are built from it, so a method's response is checked against
 * what the installed protocol says it is.
 *
 * Two liberties, both the SDK's own: `_meta` is never checked (the protocol
 * reserves it and forbids assumptions about its values), and a field the
 * SDK tags `x-deserialize-default-on-error` is accepted whatever it holds,
 * because the SDK would have defaulted it rather than refused the message.
 * Elicitation answers use the SDK's exported guards instead, because that
 * schema uses a `not` clause the converter does not take.
 */

import { z } from "zod";
import { loadOptionalPeer } from "@routecraft/routecraft";
import { ACP_PACKAGE, loadAcpSdk } from "../acp/sdk.ts";

/** What a check found wrong, one line per issue. */
export type ProtocolIssues = readonly string[];

/** A validator for one wire shape: `undefined` when the value conforms. */
export type ProtocolCheck = (value: unknown) => ProtocolIssues | undefined;

/** The subsystem the peer is loaded for, in the RC5017 hint. */
const CONSUMER = "surface (protocol validation)";

/** One node of the protocol's JSON Schema, as far as this module reads it. */
interface SchemaNode {
  readonly [key: string]: unknown;
  readonly "x-side"?: string;
  readonly "x-method"?: string;
  readonly "x-deserialize-default-on-error"?: boolean;
  readonly properties?: Record<string, SchemaNode>;
}

interface ProtocolSchema {
  readonly $defs: Record<string, SchemaNode>;
}

/** The generated JSON Schema the SDK exports, loaded once. */
let schema: Promise<ProtocolSchema> | undefined;

function loadSchema(): Promise<ProtocolSchema> {
  schema ??= loadOptionalPeer(
    () =>
      import("@agentclientprotocol/sdk/schema/schema.json", {
        with: { type: "json" },
      }).then((module) => module.default as unknown as ProtocolSchema),
    { consumer: CONSUMER, packageName: ACP_PACKAGE },
  );
  return schema;
}

/**
 * The schema as the converter takes it: `_meta` dropped from every object,
 * and every field the SDK defaults on error replaced by "anything".
 */
function loosen(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(loosen);
  if (node === null || typeof node !== "object") return node;
  const record = node as SchemaNode;
  if (record["x-deserialize-default-on-error"] === true) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "properties" && value !== null && typeof value === "object") {
      const properties: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (name !== "_meta") properties[name] = loosen(property);
      }
      out[key] = properties;
      continue;
    }
    out[key] = loosen(value);
  }
  return out;
}

let loosened: Promise<Record<string, unknown>> | undefined;

function loadDefs(): Promise<Record<string, unknown>> {
  loosened ??= loadSchema().then(
    (loaded) => loosen(loaded.$defs) as Record<string, unknown>,
  );
  return loosened;
}

const checks = new Map<string, Promise<ProtocolCheck>>();

/** Build a check for one named definition, memoised by name. */
function checkFor(name: string, consumer: string): Promise<ProtocolCheck> {
  let pending = checks.get(name);
  if (pending === undefined) {
    pending = loadDefs().then((defs) => {
      const def = defs[name];
      if (def === undefined) {
        throw new Error(
          `${consumer}: the protocol schema this version of ${ACP_PACKAGE} ships has no definition named "${name}".`,
        );
      }
      const parser = z.fromJSONSchema({
        ...(def as object),
        $defs: defs,
      } as Parameters<typeof z.fromJSONSchema>[0]);
      return (value) => {
        const parsed = parser.safeParse(value);
        return parsed.success ? undefined : describe(parsed.error);
      };
    });
    checks.set(name, pending);
    // A load that failed is retried by the next caller rather than cached
    // as a permanent refusal.
    pending.catch(() => checks.delete(name));
  }
  return pending;
}

function describe(error: z.ZodError): ProtocolIssues {
  return error.issues.map(
    (issue) =>
      `${issue.path.length === 0 ? "$" : issue.path.map(String).join(".")}: ${issue.message}`,
  );
}

/**
 * The check for what an editor answers a method with.
 *
 * Resolved from the definition the SDK tags with the method name on the
 * client side, so a method the protocol adds is checked the day its SDK
 * ships. A method the installed schema has no response for is refused
 * rather than passed through unchecked.
 */
export async function responseCheck(method: string): Promise<ProtocolCheck> {
  if (method === "elicitation/create") return elicitationCheck();
  const defs = await loadSchema();
  const name = Object.entries(defs.$defs).find(
    ([candidate, def]) =>
      def["x-side"] === "client" &&
      def["x-method"] === method &&
      candidate.endsWith("Response"),
  )?.[0];
  if (name === undefined) {
    return () => [
      `$: the protocol schema this version of ${ACP_PACKAGE} ships declares no response for "${method}"`,
    ];
  }
  return checkFor(name, `surface("${method}")`);
}

/** The check for a `session/update` a route pushes at the editor. */
export function updateCheck(): Promise<ProtocolCheck> {
  return checkFor("SessionUpdate", "surface.notify()");
}

/**
 * An elicitation answer, through the SDK's own guards: each validates its
 * variant's payload, and the custom guard admits an action outside the
 * known three, which the protocol reserves for extensions.
 */
async function elicitationCheck(): Promise<ProtocolCheck> {
  const { CreateElicitationResponse } = await loadAcpSdk(CONSUMER);
  return (value) => {
    if (value === null || typeof value !== "object") {
      return ["$: expected an object"];
    }
    const answer = value as Parameters<
      typeof CreateElicitationResponse.isAccept
    >[0];
    return CreateElicitationResponse.isAccept(answer) ||
      CreateElicitationResponse.isDecline(answer) ||
      CreateElicitationResponse.isCancel(answer) ||
      CreateElicitationResponse.isCustom(answer)
      ? undefined
      : ["$: not a well-formed elicitation response"];
  };
}

/**
 * What a permission answer is checked against beyond its shape: a
 * selection must name one of the options that were offered. The schema
 * proves `optionId` is a string; only the request knows which strings were
 * on the table, and an id nobody offered is not a decision the person
 * made.
 */
export function permissionSelectionIssue(
  sent: unknown,
  answer: unknown,
): string | undefined {
  const outcome = (
    answer as { outcome?: { outcome?: unknown; optionId?: unknown } }
  ).outcome;
  if (outcome?.outcome !== "selected") return undefined;
  const offered = (sent as { options?: ReadonlyArray<{ optionId?: unknown }> })
    .options;
  const known =
    Array.isArray(offered) &&
    offered.some((option) => option?.optionId === outcome.optionId);
  return known
    ? undefined
    : `outcome.optionId: "${String(outcome.optionId)}" is not one of the options this request offered`;
}

/**
 * The answer a route sees when the editor's permission answer could not be
 * trusted: the protocol's own "no decision was made" outcome. Failing
 * closed is the only safe direction for the one message whose job is to
 * say no.
 */
export const PERMISSION_REFUSED = Object.freeze({
  outcome: Object.freeze({ outcome: "cancelled" as const }),
});
