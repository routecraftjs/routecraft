/**
 * Placeholders for the keys `src/env.ts` validates at import time. The values
 * are never used: example tests stub the adapters that would read them.
 * Import this first, before any module that reaches `src/env.ts`.
 */
process.env["JWT_SECRET"] ??= "test-jwt-secret";
process.env["MAIL_USER"] ??= "test@example.test";
process.env["MAIL_APP_PASSWORD"] ??= "test-pw";
process.env["GEMINI_API_KEY"] ??= "test-gemini";
