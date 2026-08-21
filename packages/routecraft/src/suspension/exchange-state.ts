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
   * canonical "notify before parking" step is exactly such a tap, so the affordance follows this key back to the exchange that will
   * actually park.
   */
  OWNER: "routecraft.suspension.owner",
  /** The validated resume payload, written by the resume path before the continuation runs. */
  RESULT: "routecraft.suspension.result",
  /** Who resumed it, recorded for audit. */
  RESUMED_BY: "routecraft.suspension.resumedBy",
  /** When the resume was accepted. */
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
 * threads the `schema` option's output type into every step after the
 * `.suspend()`, the way `.input()` types the body.
 *
 * @template R - The resume payload type, threaded in by `.suspend({ schema })`
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
   * A resume token bound to one specific call on this record.
   *
   * Only a step that can raise several calls against one park needs this:
   * the agent tier's parallel tool batch is the shipped case, where every
   * handler sees the same suspension id (it names the park, not the call)
   * and each sends its own recipient a link. Binding the credential to the
   * call means the handler that then LOSES the park cannot have its
   * recipient resume the winner's park; they take `RC5055` instead.
   *
   * The binding is checked against what the record actually parked with, so
   * minting one here without the park recording the same value refuses
   * every resume. Plain `.suspend()` sites use {@link
   * SuspensionAffordance.token}.
   *
   * @throws RC5052 when the context has no suspension runtime configured.
   */
  readonly tokenFor: (callBinding: string) => string;
  /** The validated resume payload. Present only after a resume. */
  readonly result: R;
  /** Who resumed it. Present only after a resume, and only when the ingress route had a principal. */
  readonly resumedBy: PrincipalRef | undefined;
  /** When the resume was accepted. Present only after a resume. */
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
    // Checked rather than left to the type: the whole point of this member
    // is that the credential names a call, and an untyped caller reaching it
    // through a loosely typed boundary must not be able to get an unbound
    // one from it. Silently minting one would produce a link that refuses
    // every resume with RC5055, pointing at the holder rather than at the
    // call site that asked for a binding it did not have.
    tokenFor: (callBinding: string): string => {
      if (typeof callBinding !== "string") {
        throw rcError("RC5003", undefined, {
          message:
            "ex.suspension.tokenFor(callBinding) requires the call binding as a string. Use ex.suspension.token for an unbound resume token.",
        });
      }
      return mint(callBinding);
    },
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
 * A missing header is the counter at zero: every exchange that has never
 * parked legitimately carries none. Anything else that is not a usable
 * counter value REFUSES rather than resetting, because the suspension id
 * derives from this counter and resume tokens sign the id: a reset counter
 * re-derives an id an earlier park of the same owner already used, and an
 * old unspent link would verify against the new park. The store's
 * create-collision check backstops the case where the earlier record still
 * exists; this refusal closes the silent path around it.
 *
 * The throw only ever reaches suspension surfaces (`ex.suspension` is a
 * lazy getter, and the park calls this on the way in), so an exchange with
 * a mangled header still flows through routes that never touch suspension.
 *
 * @throws RC5057 when the header holds a malformed value, or a value whose
 *   successor could not itself survive this guard (the exhaustion bound:
 *   accepting it would hand `sequence + 1` to a park that the next read
 *   rejects, which is the reset this function exists to refuse)
 *
 * @internal
 */
export function readSequence(headers: ExchangeHeaders): number {
  const raw = headers[SuspensionHeaders.SEQUENCE];
  if (raw === undefined) return 0;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw rcError("RC5057", undefined, {
      message: `The suspension sequence header ("${SuspensionHeaders.SEQUENCE}") is malformed: expected a non-negative safe integer, found ${JSON.stringify(raw)}. Refusing to derive a suspension id from it, because a reset counter reuses an id an earlier park already used.`,
    });
  }
  if (raw >= Number.MAX_SAFE_INTEGER - 1) {
    throw rcError("RC5057", undefined, {
      message: `The suspension sequence header ("${SuspensionHeaders.SEQUENCE}") is exhausted at ${raw}: its successor cannot be represented, so the next park could not mint a fresh id. This value is not reachable by suspending in a loop; treat it as corruption of the framework-owned header.`,
    });
  }
  return raw;
}
