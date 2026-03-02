export {
  DefaultExchange,
  type Exchange,
  type ExchangeHeaders,
  getExchangeContext,
  HeadersKeys,
  type HeaderValue,
  OperationType,
} from "./exchange.ts";

export {
  context,
  CraftContext,
  type MergedOptions,
  type StoreRegistry,
  type CraftConfig,
  type CraftPlugin,
  type DirectConfig,
  type HttpConfig,
} from "./context.ts";

export { DefaultRoute, type Route, type RouteDefinition } from "./route.ts";

export { type Source, type CallableSource } from "./operations/from.ts";

export {
  ProcessStep,
  type Processor,
  type CallableProcessor,
} from "./operations/process.ts";

export {
  ToStep,
  type Destination,
  type CallableDestination,
} from "./operations/to.ts";

export {
  SplitStep,
  type Splitter,
  type CallableSplitter,
} from "./operations/split.ts";

export {
  type Aggregator,
  type CallableAggregator,
  defaultAggregate,
  AggregateStep,
} from "./operations/aggregate.ts";

export {
  TransformStep,
  type Transformer,
  type CallableTransformer,
} from "./operations/transform.ts";

export {
  type Filter,
  type CallableFilter,
  FilterStep,
} from "./operations/filter.ts";

export {
  type CallableHeaderSetter,
  type HeaderSetter,
  HeaderStep,
} from "./operations/header.ts";

export {
  type DestinationAggregator,
  EnrichStep,
  only,
  none,
} from "./operations/enrich.ts";

export { TapStep } from "./operations/tap.ts";

export { ValidateStep } from "./operations/validate.ts";

export {
  ContextBuilder,
  craft,
  RouteBuilder,
  type RouteOptions,
} from "./builder.ts";

export {
  RouteCraftError,
  type RCCode,
  type RCMeta,
  rcError,
  error,
  RC,
} from "./error.ts";

export {
  BRAND,
  ENRICH_MERGE_TYPE,
  INTERNALS_KEY,
  isCraftContext,
  isRoute,
  isRouteBuilder,
  isRouteDefinition,
  isRouteCraftError,
  isExchange,
} from "./brand.ts";

export { logger, childBindings } from "./logger.ts";
export type { Logger } from "pino";

export {
  type Adapter,
  type Step,
  type Consumer,
  type ConsumerType,
  type Message,
  type EventName,
  type EventHandler,
} from "./types.ts";

export { SimpleConsumer } from "./consumers/simple.ts";

export { BatchConsumer, type BatchOptions } from "./consumers/batch.ts";

export { simple } from "./adapters/simple/index.ts";
export { noop } from "./adapters/noop.ts";
export { log, debug } from "./adapters/log/index.ts";
export { direct } from "./adapters/direct/index.ts";
export { timer } from "./adapters/timer/index.ts";
export { http } from "./adapters/http/index.ts";
export { pseudo } from "@routecraft/testing";
export { browser } from "./adapters/browser.ts";
export { file } from "./adapters/file.ts";
export { html } from "./adapters/html.ts";
export { json } from "./adapters/json.ts";
export { csv } from "./adapters/csv.ts";
export { group } from "./adapters/group.ts";
export { event } from "./adapters/sources/event/index.ts";

export { SimpleSourceAdapter } from "./adapters/simple/index.ts";
export {
  LogDestinationAdapter,
  type LogOptions,
  type LogLevel,
} from "./adapters/log/index.ts";
export { NoopAdapter } from "./adapters/noop.ts";
export {
  HttpDestinationAdapter,
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
} from "./adapters/direct/index.ts";
export { DirectSourceAdapter } from "./adapters/direct/source.ts";
export { DirectDestinationAdapter } from "./adapters/direct/destination.ts";
export {
  TimerSourceAdapter,
  type TimerOptions,
} from "./adapters/timer/index.ts";
export {
  type PseudoAdapter,
  type PseudoFactory,
  type PseudoKeyedFactory,
  type PseudoOptions,
  type PseudoKeyedOptions,
} from "@routecraft/testing";
export {
  BrowserAdapter,
  type BrowserBaseOptions,
  type BrowserCommandMap,
  type BrowserCommand,
  type BrowserResult,
  type Resolvable,
  sanitizeSessionId,
} from "./adapters/browser.ts";
export { FileAdapter, type FileOptions } from "./adapters/file.ts";
export {
  HtmlAdapter,
  type HtmlOptions,
  type HtmlResult,
} from "./adapters/html.ts";
export {
  JsonAdapter,
  JsonFileAdapter,
  type JsonOptions,
  type JsonTransformerOptions,
  type JsonFileOptions,
} from "./adapters/json.ts";
export { CsvAdapter, type CsvOptions } from "./adapters/csv.ts";
export { GroupAdapter, type GroupOptions } from "./adapters/group.ts";
export {
  cosine,
  type CosineOptions,
  type Comparator,
} from "./adapters/cosine.ts";
export {
  EventSourceAdapter,
  type EventFilter,
  type EventSourceOptions,
} from "./adapters/sources/event/index.ts";
