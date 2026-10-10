---
"@routecraft/ai": minor
"@routecraft/routecraft": patch
---

`@routecraft/ai` adds `fn()`: wrap an entry of `agentPlugin({ functions })` in it and the handler's `input` is typed by the entry's own schema (its output type, after any `.transform()`), so `fn({ input: z.object({ request: z.string() }), handler: async (input) => input.request })` compiles with nothing to annotate. The record holds functions of unrelated shapes and erases each handler's input, which is why a bare object literal's handler is not checked against its schema. `fn()` returns the object it was given. `FnOptions.handler` stays a function-typed property, so a handler annotated narrower than its schema's output is a compile error; the record's entry type `FnEntry` is now `RegisteredFn | LazyFn`, where the newly exported `RegisteredFn` is the input-erased shape every typed fn is assignable to. `FnDefinition` is exported as the type `fn()` accepts.

`file()` and `directory()` are generic in the route body like `http()`: a dynamic `path` callback in `.to(file({ path: (ex) => ... }))`, `.enrich(file({ ... }))` or `.enrich(directory({ ... }))` reads the typed body instead of `Exchange<unknown>`. `FileOptions<T>`, `FileAdapter<T>`, `DirectoryOptions<T>`, `DirectoryAdapter<T>` and `DirectoryChunkedAdapter<T>` default `T` to `unknown`, so existing code is unaffected.
