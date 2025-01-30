import { walk } from "@std/fs";
import { resolve } from "@std/path";
import { ContextBuilder, type RouteDefinition } from "@routecraft/core";

export async function runCommand(path?: string) {
  const targetPath = path ? resolve(path) : Deno.cwd();

  const stat = await Deno.stat(targetPath);

  const contextBuilder = new ContextBuilder();

  if (stat.isDirectory) {
    // Handle directory case - find all .ts files
    for await (
      const entry of walk(targetPath, {
        exts: [".ts"],
        includeDirs: false,
      })
    ) {
      await configureRoutes(contextBuilder, entry.path);
    }
  } else if (stat.isFile) {
    // Handle single file case
    if (!targetPath.endsWith(".ts")) {
      console.error(
        "Error: Only TypeScript (.ts) files are supported at the moment",
      );
      Deno.exit(1);
    }
    await configureRoutes(contextBuilder, targetPath);
  }

  const context = contextBuilder.build();

  // Add signal handlers for graceful shutdown
  const ac = new AbortController();
  const signal = ac.signal;

  addEventListener("unload", () => {
    ac.abort();
    context.stop();
  });

  for (
    const sig of ["SIGINT", "SIGTERM"] as const satisfies readonly Deno.Signal[]
  ) {
    Deno.addSignalListener(sig, () => {
      console.log(`\nReceived ${sig}, shutting down...`);
      ac.abort();
      context.stop();
      Deno.exit(0);
    });
  }

  try {
    await context.start();
    // Only wait on abort if there are still active routes
    if (context.getRoutes().some(route => !route.signal.aborted)) {
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("Aborted"));
        });
      });
    }
  } catch (error) {
    if (error instanceof Error && error.message !== "Aborted") {
      console.error(error);
      Deno.exit(1);
    }
  }
}

async function configureRoutes(
  contextBuilder: ContextBuilder,
  filePath: string,
) {
  try {
    console.log(`Processing file: ${filePath}`);
    const module = await import(filePath);

    if (!module.default) {
      console.warn(`Warning: No default export found in ${filePath}`);
      return;
    }

    // Verify the type of the default export
    const defaultExport = module.default;
    const isRouteDefinition = (obj: unknown): obj is RouteDefinition =>
      typeof obj === "object" && obj !== null && "id" in obj;

    const isValidExport = Array.isArray(defaultExport)
      ? defaultExport.every(isRouteDefinition)
      : isRouteDefinition(defaultExport);

    if (!isValidExport) {
      console.error(
        `Error: Default export in ${filePath} must be a RouteDefinition or array of RouteDefinitions`,
      );
      return;
    }

    Array.isArray(defaultExport)
      ? defaultExport.every((route) => contextBuilder.routes(route))
      : contextBuilder.routes(defaultExport);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(`Error processing ${filePath}: ${error.message}`);
    } else {
      console.error(`Error processing ${filePath}: An unknown error occurred`);
    }
  }
}
