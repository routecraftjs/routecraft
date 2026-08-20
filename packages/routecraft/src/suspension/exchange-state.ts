import type { CraftContext } from "../context.ts";
import type { ExchangeHeaders } from "../exchange.ts";
import { rcError } from "../error.ts";
import { SUSPENSION_RUNTIME } from "./runtime-key.ts";
import { suspensionIdFor } from "./tokens.ts";
import type { PrincipalRef } from "./types.ts";

/**
 * Suspension state carried on the exchange.
 *
 * Per `.standards/exchange-state-model.md`, everything that must survive a
 * park lives in `headers`; `ex.suspension` is a derivation over these keys
 * plus the context's signer, in the same shape as `ex.principal` and
 * `ex.logger`. Nothing here is a second per-exchange bag.
 */
export const SuspensionHeaders = {
  /**
   * How many times this exchange has already parked. Distinguishes
   * successive suspensions of one exchange (a route that suspends, resumes,
   * and suspends again for a second approval), which is what keeps their
   * suspension ids distinct.
   */
  SEQUENCE: "routecraft.suspension.sequence",
  /**
   * Id of the exchange a snapshot was taken of, set when the framework
   * clones an exchange (`.tap()`, `.multicast()`). A clone gets a fresh
   * `routecraft.id` by design, so without this a token minted inside a
   * `.tap()` notification would name a suspension that never exists. The
   * canonical "tell the approver before parking" step is exactly such a
   * tap, so the affordance follows this key back to the exchange that will
   * actually park.
   */
  OWNER: "routecraft.suspension.owner",
  /** The validated answer, written by the resume path before the continuation runs. */
  RESULT: "routecraft.suspension.result",
  /** Who answered, recorded for audit. */
  RESUMED_BY: "routecraft.suspension.resumedBy",
  /** When the answer was accepted. */
  RESUMED_AT: "routecraft.suspension.resumedAt",
} as const satisfies Record<string, string>;

declare module "@routecraft/routecraft" {
  interface RoutecraftHeaders {
    "routecraft.suspension.sequence"?: number;
    "routecraft.suspension.owner"?: string;
    "routecraft.suspension.result"?: unknown;
    "routecraft.suspension.resumedBy"?: PrincipalRef;
    "routecraft.suspension.resumedAt"?: Date;
  }
}

/**
 * The `ex.suspension` affordance.
 *
 * Readable at any point in a pipeline, which is the whole point: `id` and
 * `token` are derived from the exchange rather than minted by the suspend
 * step, so a notification step that runs BEFORE the `.suspend()` can put a
 * working resume link in the message it sends (n8n's `$execution.resumeUrl`
 * has the same property).
 *
 * `result`, `resumedBy` and `resumedAt` are the other half: they are absent
 * on execution one and populated by the resume path before the continuation
 * runs. `result` is typed `unknown` here and narrowed by the builder, which
 * threads the `expect` schema's output type into every step after the
 * `.suspend()`, the way `.input()` types the body.
 *
 * @template R - The expected result type, threaded in by `.suspend({ expect })`
 */
export interface SuspensionAffordance<R = unknown> {
  /** Id of the suspension this exchange would park as (or parked as). */
  readonly id: string;
  /** How many times this exchange has already parked. Zero before the first suspend. */
  readonly sequence: number;
  /**
   * Signed, single-use resume token for {@link SuspensionAffordance.id}.
   *
   * @throws RC5052 when the context has no suspension runtime configured.
   */
  readonly token: string;
  /**
   * A resume token bound to one specific question on this record.
   *
   * Only a step that can raise several questions against one park needs
   * this: the agent tier's parallel tool batch is the shipped case, where
   * every handler sees the same suspension id (it names the park, not the
   * call) and each sends its own approver a link. Binding the credential to
   * the call means the handler that then LOSES the park cannot have its
   * approver answer the winner's question; they take `RC5055` instead.
   *
   * The binding is checked against what the record actually parked with, so
   * minting one here without the park recording the same value refuses
   * every resume. Plain `.suspend()` sites use {@link
   * SuspensionAffordance.token}.
   *
   * @throws RC5052 when the context has no suspension runtime configured.
   */
  readonly tokenFor: (callBinding: string) => string;
  /** The validated answer. Present only after a resume. */
  readonly result: R;
  /** Who answered. Present only after a resume, and only when the ingress route had a principal. */
  readonly resumedBy: PrincipalRef | undefined;
  /** When the answer was accepted. Present only after a resume. */
  readonly resumedAt: Date | undefined;
}

/**
 * Build the `ex.suspension` view.
 *
 * Takes the context and headers rather than the exchange so this module has
 * no runtime dependency on `exchange.ts`, which imports it back. `token` is
 * a getter because minting reaches into the context store, and the common
 * case (a route that never reads it) should not pay for that.
 *
 * @param context - Context the exchange belongs to, when it has one
 * @param headers - The exchange's headers
 * @param exchangeId - The exchange's id, which seeds the suspension id
 *   unless the exchange is a snapshot of another (see
 *   {@link SuspensionHeaders.OWNER})
 *
 * @internal
 */
export function suspensionAffordance(
  context: CraftContext | undefined,
  headers: ExchangeHeaders,
  exchangeId: string,
): SuspensionAffordance {
  const sequence = readSequence(headers);
  const id = suspensionIdOf(headers, exchangeId);
  const mint = (callBinding?: string): string => {
    const runtime = context?.getStore(SUSPENSION_RUNTIME);
    if (!runtime) {
      throw rcError("RC5052", undefined, {
        message:
          "Cannot mint a resume token: this context has no suspension runtime. Add suspension: {} to defineConfig.",
      });
    }
    return runtime.signer.mint(id, new Date(), callBinding);
  };
  return {
    id,
    sequence,
    get token(): string {
      return mint();
    },
    tokenFor: mint,
    result: headers[SuspensionHeaders.RESULT],
    resumedBy: headers[SuspensionHeaders.RESUMED_BY],
    resumedAt: headers[SuspensionHeaders.RESUMED_AT],
  };
}

/**
 * The suspension id an exchange parks as.
 *
 * The one derivation, called by the `ex.suspension` affordance and by the
 * park path alike. They must agree: the affordance is what a notification
 * step mints a token from BEFORE the park, and the park is what writes the
 * record that token has to find. Deriving it twice let them diverge for any
 * exchange carrying an owner header, which is every exchange a `.debounce()`
 * releases downstream, and the symptom was a resume link that verified and
 * then found nothing.
 *
 * @param headers - The exchange's headers
 * @param exchangeId - The exchange's own id, used when it is not a snapshot
 *
 * @internal
 */
export function suspensionIdOf(
  headers: ExchangeHeaders,
  exchangeId: string,
): string {
  return suspensionIdFor(
    headers[SuspensionHeaders.OWNER] ?? exchangeId,
    readSequence(headers),
  );
}

/**
 * Read the park counter off an exchange's headers.
 *
 * Tolerates a missing or non-numeric value rather than throwing: the header
 * is framework-owned, but headers are a user-writable bag, and a bad value
 * here would fail the exchange at a point that has nothing to do with what
 * the user did.
 *
 * @internal
 */
export function readSequence(headers: ExchangeHeaders): number {
  const raw = headers[SuspensionHeaders.SEQUENCE];
  // Every value this returns must survive a round trip through a park, which
  // writes `sequence + 1`: bounding at MAX_SAFE_INTEGER would accept a value
  // whose successor this same guard rejects, resetting the counter to 0 and
  // handing the next park an id the first one already used.
  return typeof raw === "number" &&
    Number.isSafeInteger(raw) &&
    raw >= 0 &&
    raw < Number.MAX_SAFE_INTEGER - 1
    ? raw
    : 0;
}
