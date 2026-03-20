import { mcpPlugin, jwt } from "@routecraft/ai";

export default {
  plugins: [
    mcpPlugin({
      name: "routecraft",
      version: "1.0.0",
      transport: "http",
      auth: jwt({ secret: process.env["JWT_SECRET"] ?? "dev-secret" }),
    }),
  ],
};
