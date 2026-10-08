---
"@routecraft/ai": minor
---

The optional `@huggingface/transformers` peer now requires `^4.3.1`. Versions before 4.3 pull in `sharp` 0.34, which carries GHSA-wq5f-xc86-pv6w (a HIGH librsvg vulnerability fixed in `sharp` 0.35.5). Hugging Face embeddings call the same `pipeline("feature-extraction", ...)` API on v4, so no route changes; upgrade the package with `bun add @huggingface/transformers@^4.3.1` (or your package manager's equivalent).
