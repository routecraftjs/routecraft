import { defineConfig } from "@routecraft/routecraft";
import { jwt } from "@routecraft/ai";
import { version } from "../package.json";
import { env } from "./env";
import { z } from "zod";

export const craftConfig = defineConfig({
  telemetry: { sqlite: { captureSnapshots: true } },
  mail: {
    accounts: {
      default: {
        imap: {
          host: "imap.gmail.com",
          auth: {
            user: env.MAIL_USER,
            pass: env.MAIL_APP_PASSWORD,
          },
        },
        smtp: {
          host: "smtp.gmail.com",
          auth: {
            user: env.MAIL_USER,
            pass: env.MAIL_APP_PASSWORD,
          },
          from: env.MAIL_USER,
        },
      },
    },
  },
  mcp: {
    name: "routecraft",
    version,
    transport: "http",
    auth: jwt({
      secret: env.JWT_SECRET,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }),
  },
  llm: {
    providers: {
      gemini: {
        apiKey: env.GEMINI_API_KEY,
      },
    },
  },
  agent: {
    functions: {
      currentTime: {
        description: "Current UTC timestamp in ISO 8601",
        input: z.object({}),
        handler: async () => new Date().toISOString(),
      },
    },
  },
});
