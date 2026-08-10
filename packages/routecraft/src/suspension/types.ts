/**
 * Lifecycle state of a parked exchange.
 *
 * `suspended` is the only state a suspension can be resumed from; the other
 * three are terminal. Transitions out of `suspended` go through the store's
 * compare-and-swap methods so exactly one caller wins a race between a
 * resume, a sweep, and a cancellation.
 */
export type SuspensionStatus = "suspended" | "resumed" | "expired" | "denied";

/**
 * The persisted form of a parked exchange: exactly the two stored slots of
 * `Exchange` (`body` and `headers`), per
 * `.standards/exchange-state-model.md`. Derivations (`id`, `principal`,
 * `logger`) are rebuilt by constructing a `DefaultExchange` around these
 * two on the resuming process, so there is nothing else to persist.
 *
 * Both slots are plain JSON data. `serializeExchange` refuses anything else
 * with `RC5042` rather than writing a value the store cannot round-trip.
 */
export interface SerializedExchange {
  readonly body: unknown;
  readonly headers: Readonly<Record<string, unknown>>;
}

/**
 * How the expected-result schema is carried on a stored suspension.
 *
 * A Standard Schema is a live object with a validate function, so it cannot
 * be persisted. What is persisted is a reference: the `(routeId, position)`
 * pair on the record identifies the suspending step, whose live `expect`
 * schema is read back off the route at resume time, and `hash` is folded
 * into `continuationHash` so a schema that changed under a parked exchange
 * fails the compatibility check rather than validating against the wrong
 * contract.
 *
 * `jsonSchema` is populated opportunistically from the non-standard
 * `~standard.jsonSchema` extension that Zod, ArkType and the AI SDK bridge
 * expose. It is descriptive only: it tells a caller and an operator what a
 * valid answer looks like. Validation always runs against the live schema.
 */
export interface SuspensionExpect {
  /** Stable hash of the expected-result schema. */
  readonly hash: string;
  /** JSON Schema rendering when the schema exposes one. Never used to validate. */
  readonly jsonSchema?: unknown;
}

/**
 * Audit record of who answered a suspension.
 *
 * A subset of `Principal` rather than the principal itself: the store is a
 * persistence surface, and a full principal carries claims, scopes and a
 * delegation chain that would be resurrected as data with no verification
 * behind it. What is recorded is enough to answer "who authorized this",
 * which is what the receipt is for.
 */
export interface PrincipalRef {
  readonly subject: string;
  readonly issuer?: string;
  readonly clientId?: string;
  /** The outermost actor's subject when a delegate answered on someone's behalf. */
  readonly actorSubject?: string;
}

/**
 * The cached outcome of execution two, written once the resumed exchange
 * settles. A duplicate resume returns this instead of running the
 * continuation a second time.
 */
export interface SerializedOutcome {
  readonly status: "completed" | "failed" | "dropped";
  /** Terminal body on a completed run. Plain JSON data, same rule as {@link SerializedExchange}. */
  readonly body?: unknown;
  /** Error code and message on a failed run. The stack is deliberately not persisted. */
  readonly error?: { readonly rc?: string; readonly message: string };
  /** Drop reason on a dropped run. */
  readonly reason?: string;
  readonly at: Date;
}

/**
 * A parked exchange plus everything needed to revive it.
 *
 * The record is deliberately free of anything agent-shaped. A suspending
 * step that needs to carry closure state of its own puts it in
 * {@link Suspension.stepState}, which the store never interprets; that one
 * opaque slot is what lets the agent tier (#258) share this store instead
 * of growing a second one.
 */
export interface Suspension {
  /** Suspension identity. Distinct from the parked exchange's own id. */
  readonly id: string;
  /** Route the parked exchange belongs to. Resume re-enters this route. */
  readonly routeId: string;
  /** Index of the suspending step. Execution two resumes at `position + 1`. */
  readonly position: number;
  /**
   * Hash over steps `position + 1` to the end of the pipeline plus the
   * `expect` schema. Covers step DEFINITIONS only: what a `direct()` route
   * the tail forwards to actually does, which version an adapter is on, and
   * how an external system behaves can all change without moving this hash.
   * See {@link continuationHash}.
   */
  readonly continuationHash: string;
  readonly exchange: SerializedExchange;
  readonly expect: SuspensionExpect;
  /**
   * Opaque state owned by the suspending step. Absent for an ordinary step;
   * an agent step puts its messages thread and outstanding tool-call id
   * here. The store persists it verbatim and never reads into it, so it is
   * subject to the same JSON-data rule as the exchange.
   */
  readonly stepState?: unknown;
  /**
   * Binds an approval to the operation it authorized rather than to a
   * suspension id, so a receipt reads "this principal authorized this exact
   * operation". See {@link actionFingerprint}.
   */
  readonly actionFingerprint: string;
  readonly suspendedAt: Date;
  /** When the sweeper will expire this suspension. Absent means no TTL. */
  readonly expiresAt?: Date;
  readonly status: SuspensionStatus;
  /** Cached terminal outcome of execution two, for idempotent re-resume. */
  readonly terminal?: SerializedOutcome;
  readonly resumedBy?: PrincipalRef;
  readonly resumedAt?: Date;
  /** Why a `denied` suspension was denied (cancellation, operator action). */
  readonly deniedReason?: string;
}

/**
 * A suspension as it is handed to {@link SuspensionStore.create}.
 *
 * A record is born `suspended`, so the fields only a transition can produce
 * are not part of the input. Taking a full {@link Suspension} would let a
 * caller insert a record that is already settled, and every compare-and-swap
 * in the contract then refuses to move it: the exchange is parked
 * permanently, with no error to notice.
 */
export type NewSuspension = Omit<Suspension, SuspensionTransitionField> & {
  // Declared as optional `never` rather than merely omitted. A plain `Omit`
  // is satisfied by a full `Suspension` variable, because excess-property
  // checking only fires on a fresh object literal, so the one shape most
  // likely to carry a settled status (a record read back out of the store
  // and handed to `create`) would have passed unremarked.
  readonly [K in SuspensionTransitionField]?: never;
};

/**
 * The fields only a `mark*` transition may write.
 */
type SuspensionTransitionField =
  "status" | "terminal" | "resumedBy" | "resumedAt" | "deniedReason";

/**
 * Details recorded when a resume wins the compare-and-swap.
 */
export interface SuspensionResumption {
  readonly at: Date;
  readonly by?: PrincipalRef;
}

/**
 * Result of a compare-and-swap out of `suspended`.
 *
 * `won` is the load-bearing field: it reports whether THIS caller performed
 * the transition. A resume arriving at the same moment the sweeper expires
 * the suspension produces exactly one `won: true`, and the loser reads
 * `suspension.status` to find out what happened instead.
 *
 * `suspension` is the record as it stands after the attempt, so a loser
 * does not need a second read to react. It is `undefined` only when the id
 * is unknown.
 */
export interface SuspensionCasResult {
  readonly won: boolean;
  readonly suspension: Suspension | undefined;
}

/**
 * What the startup scan reports at info level.
 */
export interface PendingSuspensionSummary {
  /** Suspensions still in `suspended` state. */
  readonly count: number;
  /** `suspendedAt` of the oldest of them, absent when there are none. */
  readonly oldest?: Date;
}

/**
 * Persistence contract for parked exchanges.
 *
 * Two backends ship: {@link MemorySuspensionStore} for tests and ephemeral
 * use, and {@link SqliteSuspensionStore} as the durable default wherever
 * the runtime allows. Postgres and redis are out of scope; the contract is
 * shaped so they can be added without touching call sites, which is why
 * every method is async and why the state transitions are compare-and-swap
 * rather than read-then-write.
 *
 * Implementations must treat the three `mark*` methods as atomic with
 * respect to each other. Single-node coordination is all that is required
 * today, but a read-then-write implementation cannot be made safe later
 * without a rewrite, and the atomic form costs nothing now.
 */
export interface SuspensionStore {
  /**
   * Persist a newly parked exchange. Throws if `record.id` already exists:
   * a suspension id is minted per suspend and a collision means a bug, not
   * a retry. The stored record is `suspended`; only the `mark*` transitions
   * move it out of that state.
   */
  create(record: NewSuspension): Promise<void>;

  /** Load a suspension by id. `undefined` when the id is unknown. */
  get(id: string): Promise<Suspension | undefined>;

  /**
   * Compare-and-swap `suspended` -> `resumed`, recording who answered and
   * when. Exactly one concurrent caller wins.
   */
  markResumed(
    id: string,
    resumption: SuspensionResumption,
  ): Promise<SuspensionCasResult>;

  /**
   * Compare-and-swap `suspended` -> `expired`. Driven by the sweeper.
   * No timestamp is recorded: `expiresAt` already says when the suspension
   * came due, and the sweeper marks it within one sweep interval.
   */
  markExpired(id: string): Promise<SuspensionCasResult>;

  /**
   * Compare-and-swap `suspended` -> `denied`. Used when a run carrying a
   * parked exchange is cancelled (#552), so a later resume surfaces a
   * catchable failure rather than reviving cancelled work.
   */
  markDenied(id: string, reason?: string): Promise<SuspensionCasResult>;

  /**
   * Cache the terminal outcome of execution two so a duplicate resume can
   * answer without re-running the continuation. Silently ignores an unknown
   * id: the outcome is a convenience, and losing the race to a sweep must
   * not turn into a second failure on the way out.
   */
  recordTerminal(id: string, terminal: SerializedOutcome): Promise<void>;

  /**
   * Suspensions still in `suspended` state whose `expiresAt` is at or
   * before `now`, oldest first. `limit` bounds one sweep pass so a store
   * that accumulated a backlog while the process was down does not produce
   * an unbounded batch.
   *
   * An omitted `limit` means unbounded. A non-positive or non-integer
   * `limit` is a caller error and throws, rather than being interpreted:
   * SQLite reads a negative LIMIT as unbounded while an array slice reads
   * it as "drop from the end", so leaving it undefined would make the two
   * backends return different rows for the same call.
   */
  findExpired(now: Date, limit?: number): Promise<Suspension[]>;

  /** Count and oldest `suspendedAt` across suspensions still parked. */
  pending(): Promise<PendingSuspensionSummary>;

  /**
   * Delete settled suspensions (`resumed`, `expired`, `denied`) that were
   * parked before `before`, and report how many went.
   *
   * A settled record holds a full serialized exchange body plus its cached
   * terminal outcome, and nothing else ever removes one. Without a
   * retention path a long-running process accumulates every exchange that
   * ever suspended: on disk under sqlite, and on the heap under the
   * in-memory backend, which is also the automatic fallback for a Node
   * install without a driver. Still-suspended records are never touched,
   * whatever their age; expiring them is the sweeper's job and goes
   * through {@link SuspensionStore.markExpired}.
   *
   * The cutoff is `suspendedAt` rather than a settled-at timestamp because
   * that is the field the record carries, and retention is measured from
   * when the work entered the store.
   */
  purgeSettled(before: Date): Promise<number>;

  /** Release backend resources. Idempotent. */
  close(): Promise<void>;
}
