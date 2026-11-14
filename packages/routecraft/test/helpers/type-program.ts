import { join } from "node:path";
import ts from "typescript";

/** The repository root, for a suite that reads source files by path. */
export const repoRoot = new URL("../../../../", import.meta.url).pathname;

/**
 * Type-check `files` as one program under the test tsconfig, for a suite
 * that asserts on declarations rather than on behaviour.
 *
 * @param files - Absolute paths of the program's root files
 */
export function typeProgram(files: readonly string[]): ts.Program {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(repoRoot, "tsconfig.bun-test.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  );
  return ts.createProgram([...files], parsed!.options);
}
