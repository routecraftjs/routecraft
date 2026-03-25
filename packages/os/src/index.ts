// CLI adapter -- expose routes as typed CLI commands
export { cli } from "./cli/index.ts";
export {
  type CliServerOptions,
  type CliClientOptions,
  type CliRouteMetadata,
  type CliArgOptions,
  type CliFlagOptions,
  ADAPTER_CLI_REGISTRY,
  isCliSource,
  getCliRegistry,
  parseFlags,
  extractJsonSchema,
  cliRunner,
} from "./cli/index.ts";
