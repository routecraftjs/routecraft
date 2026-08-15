import type { HttpAuth, HttpMethod } from "../../adapters/http/types.ts";
import type { ValidatorAuthOptions } from "../../auth/types.ts";
import type { AuthResult } from "../http/auth.ts";
import type { PathMatcher } from "../http/path-matcher.ts";

export interface HttpServerDefinition {
  kind?: "http";
  host?: string;
  port: number;
  auth?: ValidatorAuthOptions;
}

export type ServerDefinitions = Record<string, HttpServerDefinition>;

export type PathClaim =
  | {
      readonly kind: "exact";
      readonly path: string;
      readonly methods?: readonly HttpMethod[];
    }
  | {
      readonly kind: "prefix";
      readonly path: string;
    }
  | {
      readonly kind: "pattern";
      readonly matcher: PathMatcher;
      readonly staticPrefix: string;
      readonly methods?: readonly HttpMethod[];
    };

export interface HttpMount {
  readonly id: string;
  readonly claims: () => readonly PathClaim[];
  readonly auth?: HttpAuth | false;
  readonly handler: (
    request: Request,
    context: HttpMountContext,
  ) => Response | Promise<Response>;
}

export interface HttpMountContext {
  readonly serverName: string;
  readonly auth: AuthResult | undefined;
  readonly authOptions: HttpAuth | undefined;
}

export interface WebIngress {
  readonly serverName: string;
  readonly serverAuthConfigured: boolean;
  readonly boundAddress:
    { readonly host: string; readonly port: number } | undefined;
  mountHttp(mount: HttpMount): () => void;
}
