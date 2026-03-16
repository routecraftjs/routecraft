export { default as craftConfig } from "./craft.config";
import { default as helloWorld } from "./hello-world";
import { default as mcpGreet } from "./mcp-greet";
import { default as cron } from "./cron.ts";
import { default as split } from "./split.ts";

export default [helloWorld, mcpGreet, cron, split];
