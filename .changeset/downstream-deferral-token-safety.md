---
"@routecraft/ai": patch
---

Keep downstream resume tokens out of model tool results, session history and tool-result telemetry. Ordinary downstream deferrals return a token-free pending marker. Background result delivery reports AI1006 when its route defers, while leaving the action pending in the application approval flow; it no longer reports a completed action or sends the bearer token into the session inbox.
