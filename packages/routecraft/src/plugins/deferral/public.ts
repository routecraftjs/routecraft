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
  DATE_TAG,
  deserializeExchange,
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
  DeferralStoreConfig,
  DeferralTestSeams,
} from "./index.ts";

export {
  DEFERRED_JSON_SCHEMA,
  isDeferred,
  deferredSchema,
} from "../../kernel/continuation/deferred.ts";
export type { Deferred } from "../../kernel/continuation/deferred.ts";

export {
  markDeferCapable,
  routeCanDefer,
} from "../../kernel/continuation/sites.ts";
export type { DeferSite } from "../../kernel/continuation/sites.ts";

export {
  DeferSignal,
  isDeferSignal,
} from "../../kernel/continuation/signal.ts";
export type { DeferSignalRequest } from "../../kernel/continuation/signal.ts";

export { DeferralHeaders } from "../../kernel/continuation/exchange-state.ts";
export type { DeferralAffordance } from "../../kernel/continuation/exchange-state.ts";

export type {
  ResumeAcknowledgment,
  ResumeRequest,
} from "../../kernel/continuation/resume.ts";

// The in-process halves of deferral and resume, for a tier that stores a
// continuation beside a completing run and revives it itself (agent
// sessions). Internal: the public surfaces are `.defer()` / `.resume()`.
export { deferAside } from "../../kernel/continuation/park.ts";
export { reviveDeferral } from "../../kernel/continuation/resume.ts";
