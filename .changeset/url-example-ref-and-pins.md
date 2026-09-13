---
"create-routecraft": minor
---

Scaffolding from a repository resolves the ref, keeps one routecraft version, and leaves the template's CI behind (#777).

Three defects on the `--example <url>` path, all found by using it.

**A ref whose name contains a slash could not be scaffolded from.** `parseGitHubExampleUrl` took one path segment as the branch and the rest as a subpath, so `/tree/claude/my-branch` cloned branch `claude` and looked for `my-branch/` inside it. Every `feat/*`, `fix/*` and `claude/*` branch failed, and the README documented it as unresolvable.

It is resolvable, and the remote answers it. The scaffolder now asks `git ls-remote --heads --tags` before cloning and takes the longest ref that prefixes the remainder. That is exact rather than a heuristic: git stores refs as a directory tree, so `refs/heads/claude` and `refs/heads/claude/foo` cannot both exist, and at most one ref can prefix any remainder. It is also what GitHub does when it renders a `/tree/` URL.

```bash
# worked before and still does
--example https://github.com/you/repo
--example https://github.com/you/repo/tree/main/examples/api
--example https://github.com/you/repo/tree/v1.2.0

# refused before, works now
--example https://github.com/you/repo/tree/feature/login
```

A plain repository URL now takes the repository's default branch instead of assuming `main`, so a repository whose default is `master` or `trunk` scaffolds too. A miss names the branches and tags that do exist, bounded, rather than suggesting the repository might not be public when it just answered with its ref list.

**An example's routecraft pins overrode the version you asked for.** The manifest merge let the example win, so `create-routecraft@canary` against a template pinning an older canary installed that older canary, and `@routecraft/os` came out eight days behind the rest of a train the changeset config versions in lockstep. Every `@routecraft/*` entry now takes this scaffolder's own version, whatever the template pins. Everything else the template declares is still its own choice.

**`.github/workflows` is no longer copied.** A template's CI tests that template against its own branches and secrets. Copied into a new project it either fails on the first push or is guarded into never running and sits there as config nobody wrote. Excluded by path prefix rather than by segment name, so a capability folder called `workflows/` survives.
