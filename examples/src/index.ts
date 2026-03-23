export { default as craftConfig } from "./craft.config";
import { default as helloWorld } from "./hello-world";
import { default as mcpGreet } from "./mcp-greet";
import { default as mailNoreplyNotify } from "./mail-noreply-notify";
import { default as split } from "./split";

export default [helloWorld, mcpGreet, mailNoreplyNotify, ...split];
