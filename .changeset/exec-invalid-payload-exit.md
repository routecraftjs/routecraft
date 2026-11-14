---
"@routecraft/cli": minor
---

`craft exec` exits the way `craft run` does when the route refused the caller. A payload the dispatched route's own `.input()` schema refused (`RC5065`), or one a validate hook found invalid (`RC5068`), is answered 400 by the dispatch door and was reported as exit `1`, a failed route, while `craft run` reported the same refusal as `2`. Both commands now exit `2`, so a script can tell "fix the command line" from "the route failed". The same code answered with 500, raised by a route the dispatched one calls, still exits `1`. A validate hook or `.validate()` step that refused the caller with any other kind (conflict, gone, rate limited, unavailable) exits `4`, as on `craft run`, where it was `1`, or `2` for a 409. A script that treated exit `1` from `craft exec` as covering a rejected payload or a refused caller must also handle `2` and `4`.
