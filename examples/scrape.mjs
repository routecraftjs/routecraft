import { craft, simple, http, html, log, only } from "@routecraft/routecraft";
import { llmPlugin, llm } from "@routecraft/ai";
import { z } from "zod";

export const craftConfig = {
  plugins: [
    llmPlugin({
      providers: {
        ollama: {},
        gemini: {
          apiKey: process.env.GEMINI_API_KEY,
        },
        openrouter: {
          apiKey: process.env.OPENROUTER_API_KEY,
        },
      },
    }),
  ],
};

const BASE = "https://www.sourcepower.nl";

export default craft()
  .id("find-vacancies")
  .from(simple({ expertise: ["Java"] }))
  .enrich(
    http({
      url: (e) => `${BASE}/opdrachten/?_sf_s=${e.body.expertise.join(",")}`,
    }),
  )
  .transform(
    html({
      selector: 'a[href*="/opdracht/"]',
      extract: "attr",
      attr: "href",
    }),
  )
  .split()
  .enrich(
    http({
      url: (e) => e.body,
    }),
  )
  .transform(
    html({
      selector: "body",
      extract: "text",
    }),
  )
  .enrich(
    llm("gemini:gemini-2.5-flash-lite", {
      maxTokens: 8192,
      systemPrompt:
        "You are a helpful assistant that extracts the vacancy details from the vacancy detail page. The vacancy may be written in Dutch or English. If any of the fields are not available, return null. The vacancy detail page is in the body of the exchange. Return a JSON object with exactly the fields jobTitle, jobDescription, location, language. No other text or markdown. If the source is very long, summarize jobDescription so the full JSON fits without truncation.",
      outputSchema: z.object({
        jobTitle: z
          .string()
          .describe("The job title of the vacancy example: 'Java Developer'"),
        location: z
          .string()
          .describe("The location of the vacancy example: 'Amsterdam'"),
        language: z
          .string()
          .describe(
            "The language of the vacancy example: 'Dutch','English', if not available, return the language the vacancy is written in.",
          ),
        agency: z
          .string()
          .describe("The agency of the vacancy example: 'Source Power'"),
        endClient: z
          .string()
          .describe("The end client of the vacancy example: 'End Client'"),
        contactPerson: z
          .string()
          .describe("The contact person of the vacancy example: 'John Doe'"),
        contactEmail: z
          .string()
          .describe(
            "The contact email of the vacancy example: 'john.doe@example.com'",
          ),
        contactPhone: z
          .string()
          .describe("The contact phone of the vacancy example: '06-12345678'"),
        hoursPerWeek: z
          .number()
          .describe("The hours per week of the vacancy example: 32"),
        startDate: z
          .string()
          .describe("The start date of the vacancy example: '2026-01-01'"),
        vacancyId: z
          .string()
          .describe("The vacancy id of the vacancy example: '1234567890'"),
        technologies: z
          .array(z.string())
          .describe(
            "The technologies of the vacancy example: ['Java', 'Spring Boot', 'React']",
          ),
      }),
    }),
    only((r) => r.output, "summary"),
  )
  .tap(log());
// .aggregate((exchanges) => ({
//   ...exchanges[0],
//   body: exchanges.map((e) => e.body.vacancy).filter(Boolean),
// }))
// .tap(log());
