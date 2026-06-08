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
  type HeaderKeysRegistry,
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
export { defineConfig } from "./define-config.ts";
export { registerConfigApplier, type ConfigApplier } from "./config-applier.ts";
export { type HttpConfig } from "./adapters/http/types.ts";

// Side-effect: register the `http` config applier so `defineConfig({ http })`
// materialises the plugin without users importing httpPlugin manually.
import "./plugins/http/config.ts";

export { httpPlugin } from "./plugins/http/plugin.ts";
export { apiKey } from "./plugins/http/auth.ts";
/** @deprecated Use `CraftConfig.direct` instead. Will be removed in next major version. */
export { type DirectConfig } from "./adapters/direct/types.ts";

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

export { type Source, type SourceMeta } from "./operations/from.ts";

export { type Processor } from "./operations/process.ts";

export { type Destination } from "./operations/to.ts";

export { type Splitter } from "./operations/split.ts";

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

export {
  ContextBuilder,
  craft,
  RouteBuilder,
  type RouteOptions,
} from "./builder.ts";

/**
 * Type-only re-exports of the shared builder base. Exposed so that
 * `registerDsl` can augment a single interface and have both `RouteBuilder`
 * and `BranchBuilder` inherit the augmentation via class-interface
 * inheritance. The class value is deliberately not re-exported -- the base
 * is not a public extension point and the closed-world `Retyped` helper
 * falls through to `never` for any subclass outside the framework-owned
 * set.
 *
 * @internal
 */
export type { StepBuilderBase, Retyped } from "./step-builder-base.ts";

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
  rcError,
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
  type EventName,
  type EventHandler,
  type Step,
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
  type DirectRouteMetadata,
  type DirectServerOptions,
  ADAPTER_DIRECT_REGISTRY,
  getDirectChannel,
  sanitizeEndpoint,
} from "./adapters/direct/index.ts";
export { type TimerOptions } from "./adapters/timer/index.ts";
export {
  type CronExpression,
  type CronOptions,
} from "./adapters/cron/index.ts";
export {
  type FileOptions,
  type FileAdapter,
  type FileReadAdapter,
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
} from "./adapters/csv/index.ts";
export {
  type JsonlOptions,
  type JsonlSourceOptions,
  type JsonlDestinationOptions,
  type JsonlCombinedOptions,
  type JsonlTransformerOptions,
  type JsonlReadAdapter,
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
  HEADER_MAIL_UID,
  HEADER_MAIL_FOLDER,
  HEADER_MAIL_MESSAGE_ID,
  HEADER_MAIL_FROM,
  HEADER_MAIL_TO,
  HEADER_MAIL_CC,
  HEADER_MAIL_BCC,
  HEADER_MAIL_SUBJECT,
  HEADER_MAIL_DATE,
  HEADER_MAIL_REPLY_TO,
  HEADER_MAIL_FLAGS,
  HEADER_MAIL_SENDER,
  HEADER_MAIL_RAW_HEADERS,
} from "./adapters/mail/index.ts";
