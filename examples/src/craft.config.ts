import { mcpPlugin, jwt } from "@routecraft/ai";
import { telemetry } from "@routecraft/routecraft";

const jwtSecret = process.env["JWT_SECRET"];
if (!jwtSecret) {
  throw new Error("JWT_SECRET environment variable is required");
}

export default {
  plugins: [
    telemetry({ sqlite: { captureSnapshots: true } }),
    mcpPlugin({
      name: "routecraft",
      version: "1.0.0",
      transport: "http",
      auth: jwt({ secret: jwtSecret }),
    }),
  ],
};
