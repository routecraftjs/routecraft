---
"@routecraft/cli": patch
---

The CLI no longer installs adapter dependencies it never uses. It declared thirteen packages it does not import: `agent-browser`, `execa`, `shescape`, `croner`, `imapflow`, `mailparser`, `nodemailer`, `cheerio`, `fast-xml-parser`, `papaparse`, `tsdav`, `jose` and `@opentelemetry/sdk-trace-base`. Because `craft start` runs in production, every deployed image carried all of them, `agent-browser` 0.17 with `playwright-core` and `webdriverio` included, whether or not a route used the adapter. They never served a globally installed CLI either: routes run on the project's copy of core, which looks for these packages in the project.

A project that uses one of these adapters without listing its package now fails with `RC5017` and the install command: when the route starts for a source such as `cron()`, and the first time the adapter runs for a destination or transformer such as `mail()` or `html()`. Add the package the adapter needs before upgrading:

| Adapter | Package |
| --- | --- |
| `cron()`, `.enabled({ refresh })` | `croner` |
| `mail()` | `imapflow`, `mailparser`, `nodemailer` |
| `html()` | `cheerio` |
| `xml()` | `fast-xml-parser` |
| `csv()` | `papaparse` |
| `carddav()` | `tsdav` |
| JWT verification against a JWKS | `jose` |
| OpenTelemetry tracing | `@opentelemetry/sdk-trace-base` |
| `shell()` from `@routecraft/os` | `execa`, `shescape` |
| `agentBrowser()` from `@routecraft/os` | `agent-browser` |

Shipped as a patch by decision, although a project that relied on the CLI to bring one of these in must now list it: the failure names the fix, and the gain is every production image.
