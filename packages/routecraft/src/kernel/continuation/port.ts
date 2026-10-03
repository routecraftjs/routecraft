import { port } from "../port.ts";
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
 * The resolved per-context deferral runtime: one store, one signer.
 */
export interface DeferralRuntime {
  readonly store: DeferralStore;
  readonly signer: ResumeTokenSigning;
  /**
   * What the store resolved to, for the startup log line. `custom` is a
   * store the caller supplied; reporting it as `sqlite` would mislead
   * exactly the operators who configured a backend deliberately, on the one
   * field that answers "is this deployment durable, and against what".
   */
  readonly backend: "sqlite" | "memory" | "custom";
  /**
   * False when the caller supplied the store, in which case they own its
   * lifecycle and the plugin must not close it on teardown. A user-supplied
   * backend typically wraps a pool shared with the rest of the application,
   * or is reused across two contexts in one process (which is how a
   * restart-durability test is written).
   */
  readonly ownsStore: boolean;
  /**
   * Milliseconds a deferral stays resumable when `.defer()` names no
   * `ttl`. Undefined when the context opted out with `defaultTtl: "never"`,
   * which is the only way to defer something with no deadline at all.
   */
  readonly defaultTtlMs?: number;
  /**
   * Milliseconds between sweeps. Resolved here rather than in the plugin's
   * `start()` hook so a malformed duration fails while the context is still
   * being built, which is the rule the rest of this config already follows.
   */
  readonly sweepIntervalMs: number;
  /** Milliseconds an expiry-delivery claim is honoured before redelivery. */
  readonly expiryLeaseMs: number;
  /** Milliseconds settled records are kept. Undefined means keep forever. */
  readonly retentionMs?: number;
  /**
   * The database file the sqlite store opened. Another store that must not
   * share a file with this one reads it here, through the port, because
   * the two are resolved by different plugins.
   */
  readonly path?: string;
}
