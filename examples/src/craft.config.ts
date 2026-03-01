import { mcpPlugin } from "@routecraft/ai";

export default {
  plugins: [
    mcpPlugin({
      name: "routecraft",
      version: "1.0.0",
      transport: "stdio",
    }),
  ],
};
