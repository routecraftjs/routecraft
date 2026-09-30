---
"@routecraft/routecraft": patch
---

The mail adapter accepts `nodemailer` 10 and `mailauth` 7 alongside the majors it already supported (`nodemailer` `^6.0.0 || ^10.0.6`, `mailauth` `^4.0.0 || ^5.0.0 || ^7.1.0`), so a project can install the releases that fix the published advisories: every `nodemailer` 6.x release carries open advisories (GHSA-v53p-9fqp-m79j among them), and every `mailauth` 5.x release pins a vulnerable `joi` (GHSA-6h2x-m376-mqjq). No existing install breaks; upgrading is `bun add nodemailer@^10 mailauth@^7`. `mailauth` 7 needs Node 22.19 or later, as 5 already did.
