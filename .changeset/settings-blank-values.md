---
"@routecraft/cli": patch
---

A blank flag or environment value no longer counts as supplied when resolving settings.

`--url "$CRAFT_URL"` with the variable unset expands to an empty string, and an exported `CRAFT_URL=` arrives the same way. Both used to win the precedence they never earned and override the settings file with nothing, so the CLI addressed an empty URL, or presented a bearer with nothing after it and reported that the credential was rejected. The value is trimmed rather than merely tested, so one pasted with a trailing newline is not refused with nothing to suggest the whitespace is why.

A blank written into a settings file is unchanged and still refused: that is the one source a blank can only reach by hand, and explaining it is more use than silently falling back.
