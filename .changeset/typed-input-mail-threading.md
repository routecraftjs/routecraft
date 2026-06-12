---
"@routecraft/routecraft": minor
---

`.input({ body: schema })` now retypes the route builder: the following `.from(source)` opens the pipeline with the schema's inferred output type, so the duplicated `.from<T>()` generic is no longer needed (an explicit generic still overrides). Adds `PreFromTypedBuilder` and the shared `PreFromStaging` surface. The mail send payload gains threading and custom header support: `inReplyTo` (seeds `References` too), `references`, and `headers`, so agent replies stitch into the original email thread.
