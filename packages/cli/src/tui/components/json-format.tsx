import { Text } from "ink";

/** Token types for JSON syntax coloring. */
export type TokenType =
  | "key"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "brace";

export interface JsonToken {
  text: string;
  type: TokenType;
}

/**
 * Tokenize a single line of pretty-printed JSON into colored segments.
 * Handles: keys, string values, numbers, booleans, null, and structural chars.
 */
export function tokenizeLine(line: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const re =
    /("(?:[^"\\]|\\.)*")\s*:|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b)|(\bnull\b)|([{}[\],:])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(line)) !== null) {
    // Plain text before this match (whitespace / indent)
    if (match.index > lastIndex) {
      tokens.push({ text: line.slice(lastIndex, match.index), type: "brace" });
    }

    if (match[1] !== undefined) {
      // Key (the colon is part of the regex but we split it out)
      tokens.push({ text: match[1], type: "key" });
      tokens.push({ text: ":", type: "brace" });
    } else if (match[2] !== undefined) {
      tokens.push({ text: match[2], type: "string" });
    } else if (match[3] !== undefined) {
      tokens.push({ text: match[3], type: "number" });
    } else if (match[4] !== undefined) {
      tokens.push({ text: match[4], type: "boolean" });
    } else if (match[5] !== undefined) {
      tokens.push({ text: match[5], type: "null" });
    } else if (match[6] !== undefined) {
      tokens.push({ text: match[6], type: "brace" });
    }

    lastIndex = match.index + match[0].length;
  }

  // Trailing text
  if (lastIndex < line.length) {
    tokens.push({ text: line.slice(lastIndex), type: "brace" });
  }

  return tokens;
}

export const TOKEN_COLORS: Record<TokenType, string> = {
  key: "cyan",
  string: "green",
  number: "yellow",
  boolean: "yellow",
  null: "red",
  brace: "gray",
};

/**
 * Parse a JSON string into pretty-printed lines, truncating long lines.
 */
export function formatJson(raw: string, maxWidth: number): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const pretty = JSON.stringify(parsed, null, 2);
    return pretty
      .split("\n")
      .map((line) =>
        line.length > maxWidth ? line.slice(0, maxWidth - 1) + "\u2026" : line,
      );
  } catch {
    return [raw];
  }
}

/**
 * Render a single line of JSON with syntax coloring.
 */
export function ColoredJsonLine({ line }: { line: string }) {
  const tokens = tokenizeLine(line);
  if (tokens.length === 0) return <Text>{line}</Text>;
  return (
    <Text>
      {tokens.map((token, i) => (
        <Text key={i} color={TOKEN_COLORS[token.type]}>
          {token.text}
        </Text>
      ))}
    </Text>
  );
}

/**
 * Safely parse a JSON details string.
 */
export function parseDetails(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
