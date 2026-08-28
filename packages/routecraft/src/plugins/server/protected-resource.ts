/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata, shared by every http
 * surface.
 *
 * The document is how a refused caller learns who issues acceptable
 * credentials: a 401 challenge carries a `resource_metadata` URL, the
 * caller fetches it, and `authorization_servers` plus `scopes_supported`
 * name the way in. Core owns the builder and the serving fallback (see
 * `HttpMountRegistry.dispatch`); the MCP transport consumes the same
 * builder for the document it serves on its own claimed path.
 *
 * Everything here is sourced from configuration the operator already
 * wrote: issuer from `jwt()` / `jwks()`, scopes from what a mount
 * declares. A validator with no issuer produces an honest minimal
 * document rather than an invented one.
 */

/** Root path of the RFC 9728 protected-resource metadata document. */
export const PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource";

/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata payload returned by
 * `GET /.well-known/oauth-protected-resource` (and its path-suffixed
 * variants). Optional fields are omitted from the JSON when unset.
 */
export interface ProtectedResourceMetadata {
  resource: string;
  resource_name?: string;
  authorization_servers?: string[];
  bearer_methods_supported: ["header"];
  scopes_supported?: string[];
  resource_documentation?: string;
}

/** What a metadata document is built from; every field beyond `resource` is optional. */
export interface ProtectedResourceMetadataInput {
  /** Absolute URL identifying the protected resource. */
  resource: string;
  /** Human-readable name (RFC 9728 `resource_name`). */
  resourceName?: string;
  /** Issuer(s) of acceptable tokens, from the effective validator. */
  issuer?: string | string[];
  /** Scopes this resource understands, from resolved configuration. */
  scopesSupported?: readonly string[];
  /** Documentation URL (RFC 9728 `resource_documentation`). */
  documentationUrl?: string;
}

/**
 * Build the RFC 9728 protected-resource metadata document.
 *
 * `resource` is a required input rather than a default the caller patches
 * afterwards: the resolved identity depends on the bound address, and a
 * builder that returned a knowingly wrong placeholder would let any future
 * call site silently advertise it.
 *
 * `authorization_servers` is populated from the effective validator's
 * `issuer`. When the verifier exposes no issuer, the field is omitted
 * (RFC 9728 allows that): bearer is accepted and no AS is discoverable,
 * which is the truth of a bare `{ validator }`.
 */
export function buildProtectedResourceMetadata(
  input: ProtectedResourceMetadataInput,
): ProtectedResourceMetadata {
  const metadata: ProtectedResourceMetadata = {
    resource: input.resource,
    bearer_methods_supported: ["header"],
  };
  if (input.resourceName !== undefined) {
    metadata.resource_name = input.resourceName;
  }
  if (input.issuer !== undefined) {
    metadata.authorization_servers = Array.isArray(input.issuer)
      ? [...input.issuer]
      : [input.issuer];
  }
  if (input.scopesSupported !== undefined && input.scopesSupported.length > 0) {
    metadata.scopes_supported = [...input.scopesSupported];
  }
  if (input.documentationUrl !== undefined) {
    metadata.resource_documentation = input.documentationUrl;
  }
  return metadata;
}

/**
 * The RFC 9728 metadata URL a challenge on `requestUrl` should hint at.
 *
 * Path insertion per RFC 9728 section 3.1: the well-known prefix goes
 * between the origin and the resource path, so `/ops/routes` hints at
 * `/.well-known/oauth-protected-resource/ops/routes`. The origin comes
 * from the request URL, which reflects the Host header the caller used,
 * so the hint survives port forwards and reverse proxies that preserve
 * Host.
 */
export function resourceMetadataUrlFor(requestUrl: string): string {
  const url = new URL(requestUrl);
  const suffix = url.pathname === "/" ? "" : url.pathname;
  return `${url.origin}${PROTECTED_RESOURCE_METADATA_PATH}${suffix}`;
}
