---
"@routecraft/cli": minor
---

`craft exec` exits `2` when the route refused the payload as invalid. A payload the dispatched route's own `.input()` schema refused (`RC5065`), or one a validate hook found invalid (`RC5068`), is answered 400 by the dispatch door and was reported as exit `1`, a failed route, while `craft run` reported the same refusal as `2`. Both commands now exit `2`, so a script can tell "fix the command line" from "the route failed". The same code answered with 500, raised by a route the dispatched one calls, still exits `1`. A script that treated exit `1` from `craft exec` as covering a rejected payload must also handle `2`.
