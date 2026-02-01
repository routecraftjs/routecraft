export { default as craftConfig } from "./craft.config.mjs";
import helloWorld from "./hello-world.mjs";
import enrichExample from "./enrich-example.mjs";
import directAdapter from "./direct-adapter.mjs";
import timerAdapter from "./timer-adapter.mjs";

// Export all routes as default for craft run
export default [helloWorld, enrichExample, directAdapter, timerAdapter];
