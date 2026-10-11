---
"@routecraft/routecraft": patch
"@routecraft/testing": patch
"@routecraft/cli": patch
---

`ContextBuilder.routes()` and the test context's `routes()` take any number of arguments, each a route, a builder, or a list of either, so `routes(a, b, c)` registers all three. It read only the first and dropped the rest without a word wherever types are not checked: plain JavaScript, esbuild, `node --experimental-strip-types`. The argument type is exported as `RoutesArgument`. `craft exec --help` now says typed input is piped as JSON on stdin.
