import {
  CraftContext,
  type CraftConfig,
  logger,
  RouteBuilder,
  type RouteDefinition,
} from "@routecraftjs/routecraft";

// Ensure idempotent startup across Next.js reloads
const GLOBAL_KEY = "__routecraft_context__" as const;
const GLOBAL_CONFIG_HASH_KEY = "__routecraft_config_hash__" as const;
type GlobalWithRc = typeof globalThis & {
  [GLOBAL_KEY]?: CraftContext;
  [GLOBAL_CONFIG_HASH_KEY]?: string;
};

// Simple hash function for config comparison
function hashConfig(config: unknown): string {
  return JSON.stringify(config);
}

/**
 * Extended configuration type that accepts both RouteDefinition and RouteBuilder instances
 */
export type NextjsCraftConfig = Omit<CraftConfig, "routes"> & {
  routes?:
    | RouteDefinition
    | RouteDefinition[]
    | RouteBuilder<unknown>
    | RouteBuilder<unknown>[]
    | (RouteDefinition | RouteBuilder<unknown>)[];
};

/**
 * Normalize routes by converting RouteBuilder instances to RouteDefinition arrays
 */
function normalizeRoutes(
  routes:
    | RouteDefinition
    | RouteDefinition[]
    | RouteBuilder<unknown>
    | RouteBuilder<unknown>[]
    | (RouteDefinition | RouteBuilder<unknown>)[],
): RouteDefinition[] {
  if (Array.isArray(routes)) {
    return routes.flatMap((route) =>
      route instanceof RouteBuilder ? route.build() : route,
    );
  } else if (routes instanceof RouteBuilder) {
    return routes.build();
  } else {
    return [routes];
  }
}

/**
 * Factory-style API similar to createMDX. Returns a Next.js config wrapper
 * that starts a RouteCraft context using the provided configuration.
 *
 * Accepts both RouteDefinition and RouteBuilder instances, automatically
 * calling .build() on RouteBuilder instances as needed.
 *
 * Routes are only started during development server phase (next dev),
 * not during production builds (next build) to avoid side effects.
 * Uses global context singleton to prevent double execution during HMR.
 *
 * Usage in next.config.mjs:
 *
 * import { createRoutecraft } from '@routecraftjs/nextjs';
 * import { craft, simple, log } from '@routecraftjs/routecraft';
 *
 * // With RouteBuilder (no need to call .build())
 * const myRoute = craft()
 *   .from([{ id: "hello" }, simple("Hello!")])
 *   .to(log());
 *
 * export const withRoutecraft = createRoutecraft({
 *   routes: myRoute, // or [myRoute1, myRoute2]
 * });
 * export default withRoutecraft({ ... });
 */
export function createRoutecraft(
  config: Partial<NextjsCraftConfig> | (() => Partial<NextjsCraftConfig>),
) {
  const resolveConfig = (): Partial<CraftConfig> => {
    const resolved =
      typeof config === "function"
        ? (config as () => Partial<NextjsCraftConfig>)()
        : (config as Partial<NextjsCraftConfig>);

    // Normalize routes if provided
    if (resolved.routes) {
      return {
        ...resolved,
        routes: normalizeRoutes(resolved.routes),
      };
    }

    return resolved as Partial<CraftConfig>;
  };

  return function withRoutecraftFactory<T extends Record<string, unknown>>(
    nextConfig: T | ((phase: string, opts: Record<string, unknown>) => T),
  ) {
    const init = async (cfg: T, phase?: string) => {
      try {
        // More comprehensive build phase detection
        const envPhase = process.env["NEXT_PHASE"];
        const nodeEnv = process.env["NODE_ENV"];
        const isProductionBuild =
          phase === "phase-production-build" ||
          envPhase === "phase-production-build" ||
          // Additional safety checks
          (nodeEnv === "production" &&
            (process.argv.includes("build") ||
              process.argv.includes("export")));

        // Only start routes in development (handle undefined phase in dev)
        const isDevelopmentServer =
          phase === "phase-development-server" ||
          (nodeEnv === "development" && !isProductionBuild);

        if (isDevelopmentServer) {
          const provided = resolveConfig();
          if (provided?.routes) {
            const g = globalThis as GlobalWithRc;

            // Enhanced debugging for double-execution prevention
            const configHash = hashConfig(provided);
            const existingHash = g[GLOBAL_CONFIG_HASH_KEY];
            const configChanged = existingHash !== configHash;

            logger.debug("Next.js plugin initialization", {
              phase,
              nodeEnv,
              contextExists: !!g[GLOBAL_KEY],
              configChanged,
            });

            // Create new context if none exists or config changed (for HMR)
            if (!g[GLOBAL_KEY] || configChanged) {
              // Stop existing context if config changed
              if (g[GLOBAL_KEY] && configChanged) {
                logger.info(
                  "Config changed, stopping existing context for HMR",
                );
                await g[GLOBAL_KEY].stop();
              }

              logger.info(
                "Creating new Routecraft context for Next.js development",
              );
              const ctx = new CraftContext(provided as CraftConfig);
              g[GLOBAL_KEY] = ctx;
              g[GLOBAL_CONFIG_HASH_KEY] = configHash;

              // Start context immediately
              logger.info("Starting Routecraft context");
              ctx.start().catch((err) => {
                logger.error(err, "Routecraft context failed to start");
              });

              // Best-effort shutdown hooks
              process.on("exit", () => void ctx.stop());
              process.on("SIGINT", async () => {
                await ctx.stop();
                process.exit(0);
              });
              process.on("SIGTERM", async () => {
                await ctx.stop();
                process.exit(0);
              });
            } else {
              logger.debug(
                "Routecraft context already exists and config unchanged, skipping creation",
              );
            }
          }
        } else {
          logger.debug("Skipping Routecraft startup", {
            phase,
            nodeEnv,
            reason: "Not in development server phase",
          });
        }
      } catch (err) {
        logger.error(err, "createRoutecraft initialization error");
      }

      // Return the Next.js config untouched
      return cfg;
    };

    if (typeof nextConfig === "function") {
      return (phase: string, opts: Record<string, unknown>) => {
        const cfg = (
          nextConfig as (phase: string, opts: Record<string, unknown>) => T
        )(phase, opts);
        // Fire and forget the async init - don't block Next.js config processing
        init(cfg, phase).catch((err) => {
          logger.error(err, "Failed to initialize Routecraft");
        });
        return cfg;
      };
    }

    // Fire and forget the async init - don't block Next.js config processing
    init(nextConfig as T).catch((err) => {
      logger.error(err, "Failed to initialize Routecraft");
    });
    return nextConfig as T;
  };
}
