// CLI adapter -- expose routes as typed CLI commands
export { cli } from "./cli/index.ts";
export {
  type CliServerOptions,
  type CliClientOptions,
  type CliOptions,
  type CliRouteMetadata,
  ADAPTER_CLI_REGISTRY,
  isCliSource,
  getCliRegistry,
  parseFlags,
  extractJsonSchema,
  generateHelp,
  generateCommandHelp,
  cliRunner,
} from "./cli/index.ts";
