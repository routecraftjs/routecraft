/**
 * Pluck a text payload from an exchange body for codec transformer modes.
 *
 * Shared by the codec decode transformers (json/csv/jsonl/html) so they treat
 * the incoming body the same way: an explicit `from` wins; otherwise a string
 * body is used directly, and an object carrying a string `body` property (e.g.
 * the result of `http()`) has that property used. Anything else throws an
 * adapter-specific error.
 *
 * @param body - The exchange body to read the text from.
 * @param from - Optional explicit extractor; when provided it is used verbatim.
 * @param adapter - Adapter name used to prefix the thrown error message.
 * @returns The extracted text payload.
 */
export function getBodyText<T>(
  body: T,
  from: ((body: T) => string) | undefined,
  adapter: string,
): string {
  if (from) return from(body);
  if (typeof body === "string") return body;
  if (
    body &&
    typeof body === "object" &&
    "body" in body &&
    typeof (body as { body: unknown }).body === "string"
  ) {
    return (body as { body: string }).body;
  }
  throw new Error(
    `${adapter} adapter: body must be a string, an object with a string body property (e.g. http() result), or provide a from() option`,
  );
}
