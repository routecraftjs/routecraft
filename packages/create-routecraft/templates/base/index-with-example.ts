export { default as craftConfig } from "./craft.config.js";
import helloWorldRoute from "./capabilities/hello-world.js";

// Export all routes as default for craft run
export default [helloWorldRoute];
