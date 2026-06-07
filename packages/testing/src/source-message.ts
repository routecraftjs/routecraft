import {
  SOURCE_FIXTURE,
  type ExchangeHeaders,
  type SourceFixture,
} from "@routecraft/routecraft";

/**
 * Wrap a message body with the headers a real source would have attached, for
 * use as a `mockAdapter(..., { source: [...] })` fixture.
 *
 * Envelope-carrying sources (mail, http) split each incoming message into a
 * payload on `exchange.body` and metadata on `routecraft.<adapter>.*` headers.
 * A bare fixture array only sets the body, so a route that reads those headers
 * cannot be exercised through the mock. `sourceMessage(body, headers)` lets the
 * mock reproduce that split.
 *
 * @example
 * ```typescript
 * const mailMock = mockAdapter(mail, {
 *   source: [
 *     sourceMessage(
 *       { text: "Tracking: ABC123" },
 *       {
 *         "routecraft.mail.from": "noreply@acme.test",
 *         "routecraft.mail.subject": "Your order has shipped",
 *       },
 *     ),
 *   ],
 * });
 * ```
 *
 * @param body - The body the source would deliver on the exchange
 * @param headers - Headers the source would attach (omit for a body-only fixture)
 * @returns A branded fixture recognised by the source-mock dispatcher
 */
export function sourceMessage<M>(
  body: M,
  headers?: ExchangeHeaders,
): SourceFixture<M> {
  return headers === undefined
    ? { [SOURCE_FIXTURE]: true, body }
    : { [SOURCE_FIXTURE]: true, body, headers };
}
