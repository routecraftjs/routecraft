---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
"@routecraft/cli": minor
---

MCP clients behind an OAuth login. `auth: connect({ clientId, scopes })` on a client under `mcp.clients` declares that it logs in with the authorization code flow and PKCE; `craft connect <client>` runs the login through the browser and a loopback redirect, and stores the credential. The application refreshes the access token on a 401 and writes the rotated refresh token back with a compare-and-swap on the record's version, so an instance holding an older credential never writes it over a newer one. A client with no stored credential, or whose refresh is refused, is disabled with the reason `run craft connect <client>`; the rest of the application runs.

Core adds the credential store behind the `CREDENTIALS` port: a SQLite file (mode 0600) at `.routecraft/credentials.db` by default, configurable with `credentials: { store }` or `ROUTECRAFT_CREDENTIALS_STORE`, sealed with AES-256-GCM when `ROUTECRAFT_CREDENTIALS_KEY` (at least 32 random characters) is set. `craft connect --export` prints a seed sealed under that key, which a server imports on boot from `ROUTECRAFT_CREDENTIALS_SEED` when its store holds nothing newer. `craft connect --list`, `--all` and `craft disconnect <client>` complete the set. New error code `RC5070` for a credential store failure.
