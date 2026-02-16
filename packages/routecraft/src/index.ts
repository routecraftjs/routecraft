export {
  DefaultExchange,
  type Exchange,
  type ExchangeHeaders,
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

export { type DestinationAggregator, EnrichStep } from "./operations/enrich.ts";

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
  error,
  RC,
} from "./error.ts";

export {
  logger,
  createLogger,
  configureLogger,
  type Logger,
} from "./logger.ts";

export {
  type Adapter,
  type Step,
  type Consumer,
  type ConsumerType,
  type Message,
} from "./types.ts";

export { SimpleConsumer } from "./consumers/simple.ts";

export { BatchConsumer, type BatchOptions } from "./consumers/batch.ts";

export { simple } from "./adapters/simple.ts";
export { noop } from "./adapters/noop.ts";
export { log, debug } from "./adapters/log.ts";
export { direct } from "./adapters/direct.ts";
export { timer } from "./adapters/timer.ts";
export { fetch } from "./adapters/fetch.ts";
export { pseudo } from "./adapters/pseudo.ts";

export { SimpleAdapter } from "./adapters/simple.ts";
export { LogAdapter, type LogOptions, type LogLevel } from "./adapters/log.ts";
export { NoopAdapter } from "./adapters/noop.ts";
export {
  FetchAdapter,
  type FetchOptions,
  type FetchResult,
} from "./adapters/fetch.ts";
export {
  DirectAdapter,
  type DirectBaseOptions,
  type DirectChannel,
  type DirectChannelType,
  type DirectDestinationOptions,
  type DirectOptions,
  type DirectRouteMetadata,
  type DirectSourceOptions,
} from "./adapters/direct.ts";
export { TimerAdapter, type TimerOptions } from "./adapters/timer.ts";
export {
  type PseudoAdapter,
  type PseudoFactory,
  type PseudoKeyedFactory,
  type PseudoOptions,
  type PseudoKeyedOptions,
} from "./adapters/pseudo.ts";

export { TestContext, testContext } from "./test.ts";
