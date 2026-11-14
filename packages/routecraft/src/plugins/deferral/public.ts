export type {
  ExpiredScanCursor,
  NewDeferral,
  PendingDeferralSummary,
  PrincipalRef,
  SerializedExchange,
  SerializedOutcome,
  Deferral,
  ErrorPathRecord,
  DeferralCasResult,
  DeferralClaim,
  DeferralClaimId,
  DeferralClaimResult,
  DeferralListCursor,
  DeferralListQuery,
  DeferralSummary,
  DeferralSchema,
  DeferralResumption,
  DeferralState,
  DeferralOutcome,
  DeferralWaitingFor,
  DeferralStore,
} from "../../kernel/continuation/types.ts";
export {
  claimed,
  claimedBy,
  claimResultOf,
  resumable,
  summariseDeferral,
} from "../../kernel/continuation/types.ts";

export { MemoryDeferralStore } from "./memory-store.ts";
export {
  DEFAULT_DEFERRAL_DB_PATH,
  SqliteDeferralStore,
} from "./sqlite-store.ts";
export type {
  SqliteDriverName,
  ResolvedSqliteDriver,
} from "../../shared/sqlite/driver.ts";

export {
  ResumeTokenSigner,
  DEFERRAL_SECRET_ENV,
  resolveSigningSecret,
} from "./tokens.ts";
export type { SigningSecretOptions } from "./tokens.ts";
export {
  deferralIdFor,
  type ResumeTokenPayload,
  type ResumeTokenSigning,
  type SigningSecretSource,
} from "../../kernel/continuation/port.ts";

export {
  actionFingerprint,
  continuationTailHash,
  describeSchema,
  stepStateFingerprint,
} from "../../kernel/continuation/hash.ts";

export type {
  ResumeAuthorizer,
  ResumeAuthorizerInput,
  ResumeElevator,
  DeferralRecordView,
} from "../../kernel/continuation/door.ts";
export {
  BUFFER_TAG,
  BYTES_TAG,
  DATE_TAG,
  decodeOutcome,
  decodePersistable,
  deserializeExchange,
  detachPersistable,
  encodeOutcome,
  serializeExchange,
} from "../../kernel/continuation/serialize.ts";

export {
  CONTINUATIONS,
  DEFERRAL_STORE_ENV,
  createDeferralRuntime,
  deferralPlugin,
} from "./index.ts";
export type {
  DeferralConfig,
  DeferralRuntime,
  ResolvedDeferral,
  DeferralStoreConfig,
  DeferralTestSeams,
} from "./index.ts";

export {
  DEFERRED_JSON_SCHEMA,
  isDeferred,
  deferredSchema,
} from "../../kernel/continuation/deferred.ts";
export type { Deferred } from "../../kernel/continuation/deferred.ts";

export { routeCanDefer } from "../../kernel/continuation/sites.ts";
export type {
  DeferDeclaration,
  DeferringAdapter,
  DeferringStep,
  DeferSite,
  ResumingStep,
} from "../../kernel/continuation/sites.ts";
export type {
  DeferAsideRequest,
  DeferHandle,
  DeferHandleFor,
  NextStepDeferHandle,
  DeferRequest,
  DeferRevival,
  ResumeFn,
} from "../../kernel/continuation/handles.ts";

export { isDeferSignal } from "../../kernel/continuation/signal.ts";

export { DeferralHeaders } from "../../kernel/continuation/exchange-state.ts";
export type { DeferralAffordance } from "../../kernel/continuation/exchange-state.ts";

export type {
  ResumeAcknowledgment,
  ResumeRequest,
  RevivalOptions,
} from "../../kernel/continuation/resume.ts";

export { continuationsOf } from "../../kernel/continuation/facade.ts";
export type {
  Continuations,
  ContinuationsView,
} from "../../kernel/continuation/facade.ts";
