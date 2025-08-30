import { type LogBinder } from "../adapters/log";

export class ConsoleLogBinder implements LogBinder {
  readonly type = "log" as const;
  readonly name = "log:console";
  log(message?: unknown, ...optionalParams: unknown[]): void {
    // eslint-disable-next-line no-console
    console.log(message, ...(optionalParams as []));
  }
}
