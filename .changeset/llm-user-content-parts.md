---
"@routecraft/ai": minor
---

`agent()` and `llm()` accept content parts in the user prompt (#697).

A user prompt can now be an array of typed parts instead of a string, so a route that receives a voice note hands the audio to the model rather than transcribing it first and prompting with the text. The same holds for an image on a mail or a PDF pulled from a drive.

```ts
.to(agent({
  system: 'answer the caller',
  user: (ex) => [
    { type: 'file', data: ex.body.audio, mediaType: 'audio/ogg' },
    { type: 'text', text: 'Answer the question in the recording.' },
  ],
}))
```

**The parts are the SDK's own vocabulary**, deliberately: `text`, `file` and `image` mirror the Vercel AI SDK's `TextPart`, `FilePart` and `ImagePart`, so one mapping serves every provider the SDK supports instead of one translation per provider. A type-level test pins `LlmPromptPart[]` as assignable to the SDK's `UserContent`, so a shape change in a future SDK release fails our compile rather than a user's dispatch.

**Nothing is pre-validated per provider.** A provider that cannot read a part fails through its own error. The llm reference page carries the current support list and the caveat that it is per model as well as per provider.

**`system` stays string-only.** No provider takes content parts there.

**A string prompt behaves exactly as before.** `user` as a string, a callback returning a string, and an omitted `user` all resolve as they always have; an empty parts array is treated as an empty prompt, matching what an empty string already does. Note that the two destinations already differed on an empty prompt and still do: `llm()` falls back to the body, `agent()` sends it as given. The reference page now says so, because a callback that maps attachments to parts returns an empty array on an exchange carrying none.

Two limits worth knowing, both documented on the reference page. A part carrying a URL is downloaded by the SDK from your process unless the provider declares it can fetch the URL itself. And a suspension boundary carries JSON data only, so an agent that parks refuses a `Uint8Array` or a `URL` instance in a part at park time, naming the exact part: on a route that can park, pass a base64 string, or the URL as a plain string, which the SDK still reads as a URL.

`AgentUserPromptSource` now aliases the widened `LlmUserPromptSource`; `LlmPromptSource` is unchanged and still types `system`.
