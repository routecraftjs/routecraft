import { defineConfig } from "@routecraft/routecraft";
import { jwt } from "@routecraft/ai";
import { version } from "../package.json";

export const craftConfig = defineConfig({
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
  mcp: {
    name: "routecraft",
    version,
    transport: "http",
    auth: jwt({
      secret: process.env["JWT_SECRET"] ?? "",
      issuer: process.env["JWT_ISSUER"] ?? "https://idp.example.com",
      audience: process.env["JWT_AUDIENCE"] ?? "https://mcp.example.com",
    }),
  },
});
