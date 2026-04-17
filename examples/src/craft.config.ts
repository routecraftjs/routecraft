import { mcpPlugin, jwt, llmPlugin } from "@routecraft/ai";
import type { CraftConfig } from "@routecraft/routecraft";
import { version } from "package.json";

export const craftConfig: CraftConfig = {
  telemetry: { sqlite: { captureSnapshots: true } },
  mail: {
    accounts: {
      default: {
        imap: {
          host: "imap.gmail.com",
          auth: {
            user: process.env["MAIL_USER"] ?? "",
            pass: process.env["MAIL_APP_PASSWORD"] ?? "",
          },
        },
        smtp: {
          host: "smtp.gmail.com",
          auth: {
            user: process.env["MAIL_USER"] ?? "",
            pass: process.env["MAIL_APP_PASSWORD"] ?? "",
          },
          from: process.env["MAIL_USER"] ?? "",
        },
      },
    },
  },
  plugins: [
    mcpPlugin({
      name: "routecraft",
      version: version,
      transport: "http",
      auth: jwt({
        secret: process.env["JWT_SECRET"] ?? "",
        issuer: process.env["JWT_ISSUER"] ?? "https://idp.example.com",
        audience: process.env["JWT_AUDIENCE"] ?? "https://mcp.example.com",
      }),
    }),
    llmPlugin({
      providers: {
        gemini: { apiKey: process.env["GEMINI_API_KEY"] ?? "" },
        openrouter: { apiKey: process.env["OPENROUTER_API_KEY"] ?? "" },
      },
    }),
  ],
};
