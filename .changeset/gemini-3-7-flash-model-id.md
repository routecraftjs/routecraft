---
"@routecraft/ai": patch
---

`gemini:gemini-3.7-flash` is offered by autocomplete.

`LlmModelId` is a suggestion list rather than a constraint (it ends in
`| string`), so the model was always usable; it just did not appear when
typing. The Gemini section's comment no longer says "preview" either, since
the line it describes is no longer only previews.
