# Design documents

**direction/** is the user-facing documentation of where the architecture is
going, end to end, with figures; start there. The two files below are the
earlier design record.

Markdown renderings of two artifacts, checked in so an agent with the repo has
everything without needing artifact access.

- **DESIGN.md**: principles, what is impossible today, what the code shows,
  the blocks, the plugins, the design, the spike findings, the sequence, the
  acceptance tests, the open questions.
- **REGISTER.md**: the boundary register: the evidence behind every claim
  DESIGN.md makes about the current codebase, plus the attributed inputs that
  produced it and the entries that turned out to be wrong.

Both are drafts. **Treat every number in them as a claim to be reproduced, not
as ground truth.** Five claims in earlier drafts were confidently wrong and
were caught only by reading the tree. The register keeps one of them as
`Withdrawn` rather than deleting it, because the mistake was about method.
