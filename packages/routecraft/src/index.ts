export { jwt } from "./auth/jwt.ts";
export type {
  JwtAuthOptions,
  JwtHmacOptions,
  JwtRsaOptions,
} from "./auth/jwt.ts";
export { jwks } from "./auth/jwks.ts";
export type { JwksOptions } from "./auth/jwks.ts";
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
  type HeaderKeysRegistry,
  HeadersKeys,
  type HeaderValue,
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
export { type HttpConfig } from "./adapters/http/types.ts";
/** @deprecated Use `CraftConfig.direct` instead. Will be removed in next major version. */
export { type DirectConfig } from "./adapters/direct/types.ts";

export {
  DefaultRoute,
  type Route,
  type RouteDefinition,
  type ErrorHandler,
  type ForwardFn,
} from "./route.ts";

export { type Source } from "./operations/from.ts";

export { type Processor } from "./operations/process.ts";

export { type Destination } from "./operations/to.ts";

export { type Splitter } from "./operations/split.ts";

export { type Aggregator } from "./operations/aggregate.ts";

export { type Transformer, mapper } from "./operations/transform.ts";

export {
  type Validator,
  type CallableValidator,
  schema,
} from "./operations/validate.ts";

export { type Filter, type FilterDropResult } from "./operations/filter.ts";

export { type HeaderSetter } from "./operations/header.ts";

export {
  type DestinationAggregator,
  only,
  none,
  replace,
} from "./operations/enrich.ts";

export {
  ContextBuilder,
  craft,
  RouteBuilder,
  type RouteOptions,
} from "./builder.ts";

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
  type AdapterOverride,
  type AdapterSendCall,
  type AdapterSourceCall,
  type SendOverrideHandler,
  type SourceOverrideBehavior,
} from "./testing-hooks.ts";

export { tagAdapter, factoryArgs } from "./adapters/shared/factory-tag.ts";

export {
  type Adapter,
  type Consumer,
  type EventName,
  type EventHandler,
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
  type HttpOptions,
  type HttpResult,
  type HttpMethod,
  type QueryParams,
} from "./adapters/http/index.ts";
export {
  type DirectBaseOptions,
  type DirectChannel,
  type DirectChannelType,
  type DirectClientOptions,
  type DirectOptions,
  type DirectRouteMetadata,
  type DirectServerOptions,
  ADAPTER_DIRECT_STORE,
  ADAPTER_DIRECT_OPTIONS,
  ADAPTER_DIRECT_REGISTRY,
  sanitizeEndpoint,
} from "./adapters/direct/index.ts";
export { type TimerOptions } from "./adapters/timer/index.ts";
export {
  type CronExpression,
  type CronOptions,
  ADAPTER_CRON_OPTIONS,
} from "./adapters/cron/index.ts";
export { type FileOptions } from "./adapters/file/index.ts";
export { type HtmlOptions, type HtmlResult } from "./adapters/html/index.ts";
export {
  type JsonOptions,
  type JsonTransformerOptions,
  type JsonFileOptions,
} from "./adapters/json/index.ts";
export { type CsvOptions, type CsvRow } from "./adapters/csv/index.ts";
export {
  type JsonlOptions,
  type JsonlSourceOptions,
  type JsonlDestinationOptions,
  type JsonlCombinedOptions,
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
  MAIL_CLIENT_MANAGER,
  MailClientManager,
} from "./adapters/mail/index.ts";
