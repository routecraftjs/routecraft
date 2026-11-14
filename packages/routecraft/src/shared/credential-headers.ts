/**
 * Header names that carry a credential, lowercased. No event snapshot carries
 * them and every logger redacts them, so a name added here is kept out of
 * both. A plugin adds its own to snapshots through `secretHeaders`.
 *
 * @internal
 */
export const CREDENTIAL_HEADERS: readonly string[] = [
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
];
