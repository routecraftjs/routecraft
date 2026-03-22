import * as cheerio from "cheerio";
import type { HtmlResult, HtmlOptions } from "./types.ts";

export function getHtml<T>(
  body: T,
  from: ((body: T) => string) | undefined,
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
    "html adapter: body must be a string, an object with a string body property (e.g. http() result), or provide a from() option",
  );
}

/** Strip HTML tags so only plain text remains. Used as a safeguard for text extraction. */
export function stripHtmlTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Core HTML extraction logic shared by transformer and source adapters.
 */
export function extractHtml<T, R>(body: T, options: HtmlOptions<T, R>): R {
  const htmlString = getHtml(body, options.from);
  const extract = options.extract ?? "text";
  const selector = options.selector;
  const attr = options.attr;

  if (!selector) {
    throw new Error(
      "html adapter: selector is required for transformer mode (use with .transform() or source mode)",
    );
  }

  if (extract === "attr" && !attr) {
    throw new Error('html adapter: extract "attr" requires an attr option');
  }

  const $ = cheerio.load(htmlString);
  const $el = $(selector);
  const length = $el.length;

  const isTextExtract =
    extract === "text" || extract === "innerText" || extract === "textContent";
  const textFrom = ($node: ReturnType<typeof $>) =>
    isTextExtract
      ? $node.clone().find("style, script").remove().end().text().trim()
      : $node.text().trim();

  const getOne = (): string => {
    if (
      extract === "text" ||
      extract === "innerText" ||
      extract === "textContent"
    )
      return stripHtmlTags(textFrom($el));
    if (extract === "html") return $el.html()?.trim() ?? "";
    if (extract === "attr") return $el.attr(attr!) ?? "";
    if (extract === "outerHtml") return $el.prop("outerHTML") ?? "";
    return "";
  };
  const getMany = (): string[] => {
    const values: string[] = [];
    $el.each((_, el) => {
      const $e = $(el);
      if (
        extract === "text" ||
        extract === "innerText" ||
        extract === "textContent"
      )
        values.push(stripHtmlTags(textFrom($e)));
      else if (extract === "html") values.push($e.html()?.trim() ?? "");
      else if (extract === "attr") values.push($e.attr(attr!) ?? "");
      else if (extract === "outerHtml") values.push($e.prop("outerHTML") ?? "");
    });
    return values;
  };

  let result: HtmlResult;
  if (length === 0) {
    result = "";
  } else if (length === 1) {
    result = getOne();
  } else {
    result = getMany();
  }

  const to = options.to;
  if (to) return to(body, result) as R;
  return result as unknown as R;
}
