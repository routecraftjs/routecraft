---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
---

Enforce one shared Host and browser-origin gate for MCP and ACP before preflight, authentication and SDK dispatch. ACP previously accepted foreign Host values, including rebinding-shaped requests to an unauthenticated loopback listener with `cors: false`. Both protocols now reject missing, malformed or untrusted Host values independently of CORS and authentication.

Add `servers.<name>.allowedHostnames` for exact public hostnames preserved by reverse proxies. Bound hostnames and supported loopback aliases remain trusted, and MCP preserves its own `resource.url` hostname. Incoming Host, Forwarded and X-Forwarded-Host values never expand the trust set.

**Breaking:** requests carrying Origin now require an exact entry in the mount's `browserOrigins`, even for local browser tools. CORS is independent: `cors: false` delegates header handling to a proxy without disabling admission, and enabled CORS still refuses origins its own policy denies. Add `browserOrigins: ["http://localhost:6274"]` for local browser tooling, or name the production browser's exact origin and configure CORS at the mount or proxy. Native editor clients without Origin continue to work with a trusted Host.

Ingress-served ACP discovery uses the owning mount's gate. Rejections return 403 and emit `server:request:rejected` with bounded server, mount and reason fields. Other HTTP mounts retain their admission contract unless they register `HttpMount.requestValidation`.
