---
"@routecraft/routecraft": minor
---

A split child that fails with nothing handling it now fails the aggregate that joins it. The parent exchange fails with `RC5001`, the first child's error as its cause and the failed children's ids as `failedChildren` on `route:exchange:failed`, so the route's `.error()` handler and the caller see the failure. Before, the aggregate joined the survivors and the route succeeded with a shorter result. A child dropped by `.filter()` is still left out, and so is a child whose failure a handler recovered.

A child recovered by the route's `.error()` handler no longer ends up in the aggregate when it was not the first child to run.
