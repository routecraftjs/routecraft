export { jwt } from "./auth/jwt.ts";
export type {
  JwtAuthOptions,
  JwtHmacOptions,
  JwtRsaOptions,
} from "./auth/jwt.ts";
export { jwks } from "./auth/jwks.ts";
export type { JwksOptions } from "./auth/jwks.ts";
export { authorize, type AuthorizeOptions } from "./auth/authorize.ts";
export { authenticate, type PrincipalClaims } from "./auth/authenticate.ts";
export { isAuthentic, markAuthentic } from "./auth/authentic.ts";
export type {
  ClaimMappers,
  JwtAudience,
  OAuthPrincipal,
  OAuthTokenVerifier,
  OAuthValidatorAuthOptions,
  Principal,
  TokenVerifier,
  ValidatorAuthOptions,
} from "./auth/types.ts";

export {
  DefaultExchange,
  type Exchange,
  type ExchangeHeaders,
  getExchangeContext,
  getExchangeRoute,
  HeadersKeys,
  type HeaderValue,
  type HeaderLiteral,
  OperationType,
  type RoutecraftHeaders,
} from "./exchange.ts";

export {
  CraftContext,
  type MergedOptions,
  type StoreRegistry,
  RUNNER_ARGV,
  type CraftConfig,
  type CraftPlugin,
} from "./context.ts";
export { type Capability, registerCapability } from "./capabilities.ts";
export { defineConfig } from "./define-config.ts";
export { registerConfigApplier, type ConfigApplier } from "./config-applier.ts";
export { type HttpConfig } from "./adapters/http/types.ts";

// Side-effect: register the config appliers for first-class config keys
// (`http`, `cron`, `direct`, `mail`, `telemetry`) so `defineConfig({...})`
// materialises the wiring without users importing plugins manually. Each
// module also augments CraftConfig with its key; the core context has no
// adapter knowledge.
import "./plugins/http/config.ts";
import "./adapters/cron/config.ts";
import "./adapters/direct/config.ts";
import "./adapters/mail/config.ts";
import "./adapters/carddav/config.ts";
import "./telemetry/config.ts";

export { httpPlugin } from "./plugins/http/plugin.ts";
export { apiKey } from "./plugins/http/auth.ts";
/** @deprecated Use `CraftConfig.direct` instead. Will be removed in next major version. */
export { type DirectConfig } from "./adapters/direct/types.ts";

export {
  recovery,
  type Recovery,
  type RecoveryDrop,
  type RecoveryRethrow,
  isRecovery,
} from "./recovery.ts";

export {
  DefaultRoute,
  type Route,
  type RouteDefinition,
  type ErrorHandler,
  type ForwardFn,
  type RouteDiscovery,
  type RouteSchemas,
  type KnownTag,
  type Tag,
} from "./route.ts";

export {
  type CallableSource,
  type GeneratorSource,
  type Source,
  type SourceLike,
  type SourceMeta,
  type Subscription,
} from "./operations/from.ts";

export { type Processor } from "./operations/process.ts";

export { type Destination } from "./operations/to.ts";

export {
  type Splitter,
  type SplitResult,
  type SplitChild,
  splitChild,
  isSplitChild,
} from "./operations/split.ts";

export { type Aggregator } from "./operations/aggregate.ts";

export {
  type Transformer,
  type CallableTransformer,
  type FieldTransform,
  mapper,
} from "./operations/transform.ts";

export { mask, type MaskFn, type MaskRules } from "./operations/mask.ts";

export {
  keep,
  type Grant,
  type KeepRule,
  type KeepRules,
  type KeepOptions,
} from "./operations/keep.ts";

export {
  type Validator,
  type CallableValidator,
  schema,
} from "./operations/validate.ts";

export { type Filter, type FilterDropResult } from "./operations/filter.ts";

export {
  BranchBuilder,
  ChoiceSubBuilder,
  type ChoicePredicate,
} from "./operations/choice.ts";

export { type HeaderSetter } from "./operations/header.ts";

export { type CallableAuthenticator } from "./operations/authenticate.ts";

export {
  type DestinationAggregator,
  only,
  none,
  replace,
} from "./operations/enrich.ts";

export { WrapperStep } from "./operations/wrapper.ts";
export { ErrorWrapperStep } from "./operations/error-wrapper.ts";
export {
  CacheWrapperStep,
  type CacheOptions,
} from "./operations/cache-wrapper.ts";
export {
  type CacheProvider,
  MemoryCacheProvider,
  type MemoryCacheProviderOptions,
} from "./operations/cache-provider.ts";
export { DelayWrapperStep } from "./operations/delay-wrapper.ts";
export {
  TimeoutWrapperStep,
  type ResolvedTimeoutOptions,
} from "./operations/timeout-wrapper.ts";
export {
  RetryWrapperStep,
  type RetryOptions,
  type ResolvedRetryOptions,
} from "./operations/retry-wrapper.ts";
export {
  ThrottleWrapperStep,
  type ThrottleOptions,
  type ThrottleTimeUnit,
  type ResolvedThrottleOptions,
} from "./operations/throttle-wrapper.ts";
export {
  CircuitBreakerWrapperStep,
  type CircuitBreakerOptions,
  type CircuitBreakerState,
  type ResolvedCircuitBreakerOptions,
} from "./operations/circuit-breaker-wrapper.ts";

export {
  ContextBuilder,
  craft,
  RouteBuilder,
  type AnyRouteBuilder,
  type PreFromBuilder,
  type PreFromStaging,
  type PreFromTypedBuilder,
  type RouteOptions,
} from "./builder.ts";

/**
 * Type-only re-exports of the shared builder base and its type-state
 * machinery. Exposed so that `registerDsl` can augment a single interface
 * (`StepBuilderBase<S extends BuilderState>`) and have both `RouteBuilder`
 * and `BranchBuilder` inherit the augmentation via class-interface
 * inheritance; `SetBody` and `Retyped` are the helpers type-changing sugar
 * uses to advance the bag. The class value is deliberately not re-exported --
 * the base is not a public extension point and the closed-world `Retyped`
 * helper falls through to `never` for any subclass outside the
 * framework-owned set.
 */
export type {
  StepBuilderBase,
  BuilderState,
  SetBody,
  Retyped,
} from "./step-builder-base.ts";

export { CraftClient } from "./client.ts";

export {
  registerDsl,
  type PrimitiveKind,
  type DslRegistration,
} from "./dsl.ts";
// Side-effect import: triggers built-in sugar registrations (.log, .debug, .map, .schema)
import "./dsl.ts";

export {
  RoutecraftError,
  type RCCode,
  type RCMeta,
  type KnownErrorCategory,
  type ErrorCodeRegistry,
  rcError,
  registerErrorCodes,
  formatSchemaIssues,
  RC,
} from "./error.ts";

export {
  isCraftContext,
  isRoute,
  isRouteBuilder,
  isRouteDefinition,
  isRoutecraftError,
  isExchange,
} from "./brand.ts";

export {
  type DirectEndpointRegistry,
  type ResolveKey,
  type ResolveBody,
  type RegisteredDirectEndpoint,
} from "./registry.ts";

export { logger } from "./logger.ts";

export { shutdownHandler } from "./shutdown.ts";

export {
  RC_ADAPTER_OVERRIDES,
  SOURCE_FIXTURE,
  isSourceFixture,
  type AdapterOverride,
  type AdapterSendCall,
  type AdapterSourceCall,
  type SendOverrideHandler,
  type SourceOverrideBehavior,
  type SourceFixture,
  type SourceMessage,
} from "./testing-hooks.ts";

export { tagAdapter, factoryArgs } from "./adapters/shared/factory-tag.ts";
export { loadOptionalPeer } from "./adapters/shared/optional-peer.ts";

export {
  type OnParseError,
  DEFAULT_ON_PARSE_ERROR,
} from "./adapters/shared/parse.ts";

export {
  type Adapter,
  type Consumer,
  type ConsumerDeps,
  type ConsumerType,
  type EventDetailsMap,
  type EventName,
  type EventHandler,
  type EventPayload,
  forRoute,
  type Message,
  type ProcessingQueue,
  type Step,
  type StepContext,
  type StepOutcome,
  type StepOutcomeMetadata,
} from "./types.ts";

export { SimpleConsumer } from "./consumers/simple.ts";

export { BatchConsumer, type BatchOptions } from "./consumers/batch.ts";

export { simple } from "./adapters/simple/index.ts";
export { noop } from "./adapters/noop/index.ts";
export { log, debug } from "./adapters/log/index.ts";
export { direct } from "./adapters/direct/index.ts";
export { timer } from "./adapters/timer/index.ts";
export { cron } from "./adapters/cron/index.ts";
export { http } from "./adapters/http/index.ts";
export { file } from "./adapters/file/index.ts";
export { html } from "./adapters/html/index.ts";
export { json } from "./adapters/json/index.ts";
export { csv } from "./adapters/csv/index.ts";
export { jsonl } from "./adapters/jsonl/index.ts";
export { group } from "./adapters/group/index.ts";
export { event } from "./adapters/sources/event/index.ts";
export { mail } from "./adapters/mail/index.ts";
export { carddav } from "./adapters/carddav/index.ts";

export { type LogOptions, type LogLevel } from "./adapters/log/index.ts";
export {
  type HttpClientOptions,
  type HttpResult,
  type HttpMethod,
  type QueryParams,
  type HttpServerOptions,
  type HttpPluginOptions,
  type HttpRequestBody,
  type HttpResponseHint,
  type HttpAuth,
  type ApiKeyAuthOptions,
  type HttpBuiltinsOptions,
  type HttpBuiltinOptions,
  type HttpOpenApiBuiltinOptions,
  type HttpOpenApiInfo,
} from "./adapters/http/index.ts";
export {
  type DirectBaseOptions,
  type DirectChannel,
  type DirectChannelType,
  type DirectClientOptions,
  type DirectOptions,
  type DirectServerOptions,
} from "./adapters/direct/index.ts";
export { type TimerOptions, TimerHeaders } from "./adapters/timer/index.ts";
export {
  type CronExpression,
  type CronOptions,
  CronHeaders,
} from "./adapters/cron/index.ts";
export {
  type FileOptions,
  type FileAdapter,
  type FileReadAdapter,
  FileHeaders,
} from "./adapters/file/index.ts";
export {
  type HtmlOptions,
  type HtmlResult,
  type HtmlAdapter,
  type HtmlReadAdapter,
} from "./adapters/html/index.ts";
export {
  type JsonOptions,
  type JsonTransformerOptions,
  type JsonFileOptions,
  type JsonFileAdapterType,
  type JsonReadAdapter,
} from "./adapters/json/index.ts";
export {
  type CsvOptions,
  type CsvTransformerOptions,
  type CsvFileOptions,
  type CsvRow,
  type CsvData,
  type CsvAdapter,
  type CsvReadAdapter,
  CsvHeaders,
} from "./adapters/csv/index.ts";
export {
  type JsonlOptions,
  type JsonlFileOptions,
  type JsonlTransformerOptions,
  type JsonlReadAdapter,
  JsonlHeaders,
} from "./adapters/jsonl/index.ts";
export { type GroupOptions } from "./adapters/group/index.ts";
export {
  cosine,
  type CosineOptions,
  type Comparator,
} from "./adapters/cosine/index.ts";
export {
  type EventFilter,
  type EventSourceOptions,
} from "./adapters/sources/event/index.ts";

export { telemetry } from "./telemetry/index.ts";
export {
  SqliteSpanProcessor,
  SqliteConnection,
  SqliteEventWriter,
  ATTR,
  SPAN_KIND,
} from "./telemetry/index.ts";
export type {
  TelemetryOptions,
  TelemetrySqliteOptions,
  TelemetryEvent,
} from "./telemetry/index.ts";
export {
  type MailAuth,
  type MailReconnectOptions,
  type MailServerOptions,
  type MailClientOptions,
  type MailOptions,
  type MailBody,
  type MailMessage,
  type MailAttachment,
  type MailSendPayload,
  type MailSendResult,
  type MailFetchResult,
  type MailContextConfig,
  type MailAccountConfig,
  type MailAccountImapConfig,
  type MailAccountSmtpConfig,
  type MailAction,
  type MailMoveAction,
  type MailCopyAction,
  type MailDeleteAction,
  type MailFlagAction,
  type MailUnflagAction,
  type MailAppendAction,
  type MailTargetExtractor,
  type MailSender,
  type EmailAddress,
  type ForwardHop,
  type ForwardType,
  type TrustLevel,
  analyzeHeaders,
  parseAuthResults,
  ANALYSIS_HEADER_NAMES,
  MailClientManager,
  MailHeaders,
} from "./adapters/mail/index.ts";
export {
  CarddavAdapter,
  CarddavClientManager,
  CARDDAV_CLIENT_MANAGER,
  DEFAULT_CARDDAV_SERVER_URL,
  CarddavHeaders,
  VCard,
  VCardProperty,
  parseVCard,
  VCARD,
  VPARAM,
  type KnownProperty,
  type KnownParam,
  type CarddavOptions,
  type CarddavServerOptions,
  type CarddavClientOptions,
  type CarddavContextConfig,
  type CarddavAccountConfig,
  type CarddavAction,
  type CarddavTargetExtractor,
  type CarddavWriteResult,
  type CarddavDeleteResult,
  type CarddavDriverClient,
  type DAVAddressBookLike,
  type DAVVCardLike,
  type ResolvedCarddavConnection,
  type VCardBody,
  type VCardPropertyData,
  type VCardPropertyOptions,
  type VCardParam,
} from "./adapters/carddav/index.ts";
