import { plugin as mcp } from "@routecraft/ai";

const config = {
  plugins: [
    mcp({
      name: "routecraft",
      version: "1.0.0",
      transport: "stdio",
    }),
  ],
};

export default config;
