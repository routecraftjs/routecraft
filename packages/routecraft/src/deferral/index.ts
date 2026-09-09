export type {
  ExpiredScanCursor,
  NewDeferral,
  PendingDeferralSummary,
  PrincipalRef,
  SerializedExchange,
  SerializedOutcome,
  Deferral,
  DeferralCasResult,
  DeferralSchema,
  DeferralResumption,
  DeferralStatus,
  DeferralStore,
} from "./types.ts";

export { MemoryDeferralStore } from "./memory-store.ts";
export {
  DEFAULT_DEFERRAL_DB_PATH,
  SqliteDeferralStore,
} from "./sqlite-store.ts";
export type {
  SqliteDriverName,
  ResolvedSqliteDriver,
} from "../shared/sqlite/driver.ts";

export {
  ResumeTokenSigner,
  DEFERRAL_SECRET_ENV,
  resolveSigningSecret,
  deferralIdFor,
} from "./tokens.ts";
export type {
  ResumeTokenPayload,
  SigningSecretOptions,
  SigningSecretSource,
} from "./tokens.ts";

export {
  actionFingerprint,
  continuationTailHash,
  describeSchema,
  stepStateFingerprint,
} from "./hash.ts";

export type {
  ResumeAuthorizer,
  ResumeAuthorizerInput,
  DeferralRecordView,
} from "./authorize.ts";

export {
  DATE_TAG,
  deserializeExchange,
  serializeExchange,
} from "./serialize.ts";

export {
  DEFERRAL_RUNTIME,
  DEFERRAL_STORE_ENV,
  createDeferralRuntime,
  deferralPlugin,
} from "./config.ts";
export type {
  DeferralConfig,
  DeferralRuntime,
  DeferralStoreConfig,
  DeferralTestSeams,
} from "./config.ts";

export {
  DEFERRED_JSON_SCHEMA,
  isDeferred,
  deferredSchema,
} from "./deferred.ts";
export type { Deferred } from "./deferred.ts";

export { markDeferCapable, routeCanDefer } from "./sites.ts";
export type { DeferSite } from "./sites.ts";

export { DeferSignal, isDeferSignal } from "./signal.ts";
export type { DeferSignalRequest } from "./signal.ts";

export { DeferralHeaders } from "./exchange-state.ts";
export type { DeferralAffordance } from "./exchange-state.ts";

export type { ResumeAcknowledgment, ResumeRequest } from "./revive.ts";

// The in-process halves of park and resume, for a tier that stores a
// continuation beside a completing run and revives it itself (agent
// sessions). Internal: the public surfaces are `.defer()` / `.resume()`.
export { parkAside } from "./defer.ts";
export { reviveDeferral } from "./revive.ts";
