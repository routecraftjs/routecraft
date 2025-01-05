import { walk } from "@std/fs";
import { resolve } from "@std/path";
import { ContextBuilder, type RouteDefinition } from "@routecraft/core";

export async function runCommand(path?: string) {
  const targetPath = path ? resolve(path) : Deno.cwd();

  try {
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

    await contextBuilder.build().run();
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(error);
    } else {
      console.error("An unknown error occurred");
    }
    Deno.exit(1);
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
