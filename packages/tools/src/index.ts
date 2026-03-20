// CLI adapter -- expose routes as typed CLI commands
export { cli } from "./cli/index.ts";
export {
  type CliServerOptions,
  type CliClientOptions,
  type CliOptions,
  type CliRouteMetadata,
  type CliParsedArgs,
  ADAPTER_CLI_REGISTRY,
  ADAPTER_CLI_ARGS,
  isCliSource,
  getCliRegistry,
  parseFlags,
  extractJsonSchema,
} from "./cli/index.ts";
