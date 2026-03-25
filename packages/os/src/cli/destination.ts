import type { Exchange, Destination } from "@routecraft/routecraft";
import type { CliClientOptions } from "./types.ts";

/**
 * CliDestinationAdapter implements the Destination interface for the CLI adapter.
 *
 * Writes the exchange body to stdout or stderr. Used with `.to(cli.stdout())`
 * or `.to(cli.stderr())`.
 *
 * - Strings are written as-is with a trailing newline.
 * - Objects and arrays are pretty-printed as JSON.
 * - All other values are converted via String().
 */
export class CliDestinationAdapter<T = unknown> implements Destination<
  T,
  void
> {
  readonly adapterId: string = "routecraft.adapter.cli";

  constructor(private options: CliClientOptions = {}) {}

  async send(exchange: Exchange<T>): Promise<void> {
    const { stream = "stdout" } = this.options;
    const output = stream === "stderr" ? process.stderr : process.stdout;
    const body = exchange.body;

    let text: string;
    if (typeof body === "string") {
      text = body;
    } else if (body === null || body === undefined) {
      text = "";
    } else if (typeof body === "object") {
      text = JSON.stringify(body, null, 2);
    } else {
      text = String(body);
    }

    output.write(text + "\n");
  }
}
