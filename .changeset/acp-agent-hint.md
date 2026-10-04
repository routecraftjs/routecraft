---
"@routecraft/ai": patch
---

An instance holding several agents and no `acpPlugin({ agent })` default now tells the editor user to choose one with `craft acp --agent <name>`. The refusal used to point at an `agent` config option the editor protocol mount does not offer.
