import { rcError } from "../../error.ts";
import { port, type PortLookup } from "../port.ts";
import type { DeferralStore } from "./types.ts";

/**
 * The port the deferral plugin provides: where continuations are kept, how
 * resume tokens are signed, and the default deadline.
 *
 * The kernel's park, resume and sweep, the `ex.deferral` facet and any
 * plugin that parks work aside (agent sessions) reach one resolved store and
 * one signer per application through it, never through each other.
 */
export const CONTINUATIONS = port<DeferralRuntime>(
  "routecraft.continuations@1",
);

/**
 * A signed capability naming one deferral.
 *
 * The token proves that whoever holds it was handed it by this deployment.
 * It does NOT prove the holder may resume: authorizing the resuming
 * principal is the resume ingress route's job (`.resume({ authorize })`,
 * sender verification, a per-recipient link), which is where an
 * authenticated principal is available. Nor does the token enforce single use on its own; the store's
 * compare-and-swap does that, so a replayed token finds the deferral
 * already resumed and gets the cached continuation result instead of a second
 * execution.
 */
export interface ResumeTokenPayload {
  /** Deferral this token resumes. */
  readonly id: string;
  /** Mint time, epoch milliseconds. Carried for audit, not enforced. */
  readonly iat: number;
  /**
   * The call this credential belongs to, when the deferring step can raise
   * more than one at a time.
   *
   * A deferral id names a RECORD; on the agent surface a single record is
   * reached through whichever tool call won a parallel batch, and every
   * handler in that batch is handed a credential before the winner is
   * known. Binding the credential to its own call is what stops the loser's
   * recipient from resuming the winner's deferral: revive compares this claim
   * against the record's own `stepState.deferredToolCallId` and refuses a
   * mismatch before touching the record.
   *
   * Absent for a static `.defer()`, which has exactly one logical call.
   * Both mismatched arms fail closed: a token without this claim cannot
   * resume a record that has a bound call, and a token carrying it cannot
   * resume a record that has none.
   */
  readonly sub?: string;
}

/** Where a context's signing secret came from. */
export type SigningSecretSource = "config" | "env" | "ephemeral";

/**
 * Separator between the exchange id and the sequence number.
 *
 * Unreserved in RFC 3986, chosen so the framework's own contribution to the
 * id needs no escaping. `#` would have started a fragment and truncated the
 * id at its first hop through a browser.
 *
 * This does NOT make a deferral id URL-safe on its own: the exchange id it
 * wraps is opaque, and an adapter is free to set `headers["routecraft.id"]`
 * from an upstream message id containing anything at all. A deferral id is
 * an identifier, not a URL component; whoever embeds one in a resume link
 * percent-encodes it there.
 */
const DEFERRAL_ID_SEPARATOR = "~";

/**
 * Derive the id of a deferral from the exchange that will defer.
 *
 * Deterministic on purpose: `ex.deferral.token` and
 * `ex.deferral.resumeUrl` must be readable by a notification step that
 * runs BEFORE the defer, so the id cannot be minted by the defer step
 * itself. The exchange id is the natural key, and `sequence` distinguishes
 * successive defers of the same exchange, which happens whenever a route
 * defers, resumes, and defers again for a second approval.
 *
 * The sequence is always appended, including for the first deferral. Omitting it
 * at zero looks tidier and collides: an exchange whose id already ends in
 * `~1` (ids are `randomUUID()` by default but an adapter may set
 * `headers["routecraft.id"]` from an upstream message id) would produce the
 * same deferral id as that exchange's second deferral. Two unrelated deferred
 * exchanges sharing an id means one overwrites the other in the store.
 * Appending unconditionally is injective, because the suffix is a canonical
 * decimal after the final separator.
 *
 * @param exchangeId - The deferring exchange's id.
 * @param sequence - How many times this exchange has already deferred.
 *
 * @internal
 */
export function deferralIdFor(exchangeId: string, sequence: number): string {
  return `${exchangeId}${DEFERRAL_ID_SEPARATOR}${sequence}`;
}

/** What the kernel needs of the token signer the deferral plugin provides. */
export interface ResumeTokenSigning {
  /** Where the signing secret came from, for the startup log line. */
  readonly source: SigningSecretSource;
  /** Sign a resume token for a deferral id, optionally bound to a subject. */
  mint(id: string, now?: Date, sub?: string): string;
  /** Verify a token and return its payload; throws when it is not genuine. */
  verify(token: string): ResumeTokenPayload;
}

/**
 * What the `CONTINUATIONS` provider hands the kernel: one store, one signer,
 * and the deadlines the park, resume and sweep apply. What the provider
 * keeps for itself (whether it opened the store, how often it sweeps) stays
 * in its own closure, so a replacement supplies only what the kernel reads.
 */
export interface DeferralRuntime {
  readonly store: DeferralStore;
  readonly signer: ResumeTokenSigning;
  /**
   * Milliseconds a deferral stays resumable when `.defer()` names no
   * `ttl`. Undefined when the application opted out with
   * `defaultTtl: "never"`, which is the only way to defer something with no
   * deadline at all.
   */
  readonly defaultTtlMs?: number;
  /** Milliseconds an expiry-delivery claim is honoured before redelivery. */
  readonly expiryLeaseMs: number;
  /** Milliseconds settled records are kept. Undefined means keep forever. */
  readonly retentionMs?: number;
  /**
   * The file or location the store opened, when it has one. Another store
   * that must not share it reads it here, through the port, because the two
   * are resolved by different plugins.
   */
  readonly path?: string;
}

/** How a missing continuations provider is remedied, in every refusal. */
export const CONTINUATIONS_REMEDY =
  "Add deferral: {} to defineProject (or defineConfig) to take the defaults, or deferral: { store, secret } to be explicit.";

/**
 * The application's continuations provider, for a caller that cannot go
 * on without one.
 *
 * @param context - Where the port is looked up; `undefined` when the caller
 *   has no application at all
 * @param attempted - What was being done, for the refusal to name
 * @throws RC5052 when no installed plugin provides `CONTINUATIONS`
 *
 * @internal
 */
export function requireContinuations(
  context: PortLookup | undefined,
  attempted: string,
): DeferralRuntime {
  const runtime = context?.lookup(CONTINUATIONS);
  if (!runtime) {
    throw rcError("RC5052", undefined, {
      message: `${attempted}, but this application has no deferral runtime. ${CONTINUATIONS_REMEDY}`,
    });
  }
  return runtime;
}
