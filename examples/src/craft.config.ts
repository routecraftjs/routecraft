import { mcpPlugin } from "@routecraft/ai";
import { telemetry } from "@routecraft/routecraft";

export default {
  plugins: [
    telemetry(),
    mcpPlugin({
      name: "routecraft",
      version: "1.0.0",
      transport: "http",
    }),
  ],
};
