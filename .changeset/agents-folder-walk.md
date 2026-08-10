---
"@routecraft/ai": minor
---

`agents()` owns the `agents/` folder walk (#324).

The loader now matches [Claude Code's subagent convention](https://code.claude.com/docs/en/sub-agents), so an existing `.claude/agents/` tree loads unmodified. The layout rules live here rather than in the CLI, so a programmatic caller and the project runtime walk the tree the same way.

**Recursive, and identity comes from frontmatter.** A `.md` file at any depth is one agent, identified by its frontmatter `name`. The filename and the folders above it are grouping and carry no identity, which is the rule that lets `review/security-reviewer.md` declare `name: security` and still resolve as `agent("security")`.

**Breaking (0.x, so `minor`): the filename no longer has to match the frontmatter `name`.** Trees that relied on the old strict check still load; nothing that worked before stops working. What changes is that a mismatch is no longer an error.

**Bundles and the reserved folder.** A directory holding `AGENT.md` is exactly one agent and is not descended into, so it can hold assets scoped to that agent. This is the one place the relaxed filename rule does not apply: the frontmatter `name` must match the bundle directory name, mirroring the check `skills()` already applies to its nested form. A directory named `skills` is never scanned for agents at any depth, so a bundle's own skills folder cannot fail the boot on its first file.

**Duplicate names throw**, naming both files. Silent shadowing is the failure that surfaces months later as "why is this agent behaving like the other one".

**`skills:` frontmatter is accepted again**, with different semantics from the key removed in 0.6: it declares where an agent's skills come from (local paths, `npm:` package refs) rather than naming blocks. The loader validates the list and surfaces it verbatim; resolving a ref needs the house and bundle folders, which a direct `agents()` call is not given, so it leaves the declaration for the project runtime to consume and records the fact at debug level.

`readMarkdownDir` grows `recursive` and `reservedDirectories`, and reports the bundle directory on documents found through a sentinel. Two shared-walk changes reach `skills()` as well: `node_modules` and dot-directories are skipped at every level, and a symlink to a file is followed while a symlink to a directory is not, which is what keeps the walk loop-free. `skills()` also now builds its record on a null-prototype object, so a skill named `__proto__` registers as a real key instead of vanishing.
