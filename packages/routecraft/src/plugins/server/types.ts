import type { HttpMethod } from "../../adapters/http/types.ts";
import type { PathMatcher } from "../http/path-matcher.ts";

export interface HttpServerDefinition {
  kind?: "http";
  host?: string;
  port: number;
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
  readonly handler: (request: Request) => Response | Promise<Response>;
}

export interface WebIngress {
  readonly serverName: string;
  mountHttp(mount: HttpMount): () => void;
}
