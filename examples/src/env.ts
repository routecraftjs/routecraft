import { z } from "zod";

const envSchema = z.object({
  JWT_SECRET: z.string().min(1),
  JWT_ISSUER: z.string().min(1).default("https://idp.example.com"),
  JWT_AUDIENCE: z.string().min(1).default("https://mcp.example.com"),
  MAIL_USER: z.string().min(1),
  MAIL_APP_PASSWORD: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
});

export const env = envSchema.parse(process.env);
