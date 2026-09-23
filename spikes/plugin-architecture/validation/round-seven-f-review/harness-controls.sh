#!/usr/bin/env bash
# Runs the round-two mutation runner, UNCHANGED, against disposable copies of
# the spike whose mutant list (and, for one control, whose source) is replaced
# by a control. Each control proves or disproves one claim the runner makes.
# Nothing in the reviewed tree is touched: every copy lives under a temp dir.
set -uo pipefail
spike="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

copy() {
  local dest="$work/$1"
  mkdir -p "$dest"
  cp -R "$spike/src" "$spike/test" "$spike/validation" "$spike/package.json" "$dest/"
  echo "$dest"
}

# $1 name, $2 mutants.ts body (the array literal's entries)
with_mutants() {
  local dest
  dest="$(copy "$1")"
  printf '/** Control list. */\nexport const mutants: [string, string, string, string, string][] = [\n%s\n];\n' "$2" \
    > "$dest/validation/round-two/mutants.ts"
  echo "$dest"
}

run() {
  local dest="$1" label="$2"
  local out
  out="$(cd "$dest" && timeout 300 bun run validation/round-two/mutations.ts 2>&1)"
  local code=$?
  echo "=== $label (exit $code)"
  echo "$out" | grep -E '^(CONTROL|KILLED|SURVIVED|error|[0-9]+/[0-9]+)|unchanged copy does not pass|ambiguous|no longer applies|mutants survived' | head -20
}

# 1. The unchanged copy must pass first: break the copy's own source so a test fails.
d="$(with_mutants baseline '["positive", "codec.ts", "if (secrets.has(object))", "if (false)", "F2, F3"],')"
sed -i 's/return { \[DATE_TAG\]: object.toISOString() };/return object.toISOString();/' "$d/src/v2/codec.ts"
run "$d" "C1 broken baseline: must refuse to start"

# 2. A pattern that matches twice must be refused.
d="$(with_mutants ambiguous '["ambiguous", "runtime.ts", "return refused();", "return empty();", "F1"],')"
run "$d" "C2 ambiguous pattern: must throw"

# 3. A pattern that matches nothing must be refused.
d="$(with_mutants stale '["stale", "runtime.ts", "this text is not in runtime", "x", "F1"],')"
run "$d" "C3 stale pattern: must throw"

# 4 to 7 in one run: one real kill as the positive control, then three shapes
# that must NOT count as kills.
d="$(with_mutants shapes '
["positive: secret rule removed", "codec.ts", "if (secrets.has(object))", "if (false)", "F2, F3"],
["parse error", "codec.ts", "export const DATE_TAG", "export const const DATE_TAG", "F2, F3"],
["load-time throw", "codec.ts", "export const DATE_TAG", "throw Error(\"load\"); export const DATE_TAG", "F2, F3"],
["filter matches no test", "codec.ts", "if (secrets.has(object))", "if (false)", "no test is called this"],
["sync infinite loop at the site under test", "codec.ts", "if (secrets.has(object))", "for(;;){} if (secrets.has(object))", "F2, F3"],')"
run "$d" "C4-C8 positive, parse error, load throw, empty filter, hang"
