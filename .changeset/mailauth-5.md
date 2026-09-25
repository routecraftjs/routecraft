---
"@routecraft/routecraft": patch
---

`mail({ verify: "strict" })` accepts `mailauth` 5. Every `mailauth` 4 release pins `undici` 7.25.0, which carries four HIGH advisories, and the peer range `^4.0.0` kept users off the fixed release. The range is now `^4.0.0 || ^5.0.0`. `mailauth` 5 needs Node 22.19 or later, and it enforces DMARC strict alignment (`adkim=s`, `aspf=s`), which 4 treated as relaxed: a sender that publishes strict alignment but signs from another host under the same organisational domain now reads `dmarc: "fail"`.
