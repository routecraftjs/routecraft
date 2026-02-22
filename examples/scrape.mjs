import { log, craft, simple } from "@routecraft/routecraft";
import { llm, mcp, mcpPlugin, llmPlugin } from "@routecraft/ai";
import { z } from "zod";

export const craftConfig = {
  plugins: [
    mcpPlugin({
      clients: {
        browser: { url: "http://127.0.0.1:8089/mcp" },
      },
    }),
    llmPlugin({
      providers: {
        ollama: {},
      },
    }),
  ],
};

/**
 * Run in page: find all "Meer informatie" links (e.g. <a class="elementor-button..." href=".../opdracht/...">) and return their hrefs.
 * MCP returns result as JSON in content[0].text, so we parse if needed.
 */
const EXTRACT_MEER_INFO_LINKS_SCRIPT = `() => {
  const label = 'meer informatie';
  const links = Array.from(document.querySelectorAll('a[href*="/opdracht/"]'))
    .filter(a => a.textContent.replace(/\\\\s+/g, ' ').trim().toLowerCase().includes(label))
    .map(a => a.href);
  return [...new Set(links)];
}`;

export default craft()
  .id("find-vacancies")
  // .from(
  //   mcp("find-vacancies", {
  //     description: "Find vacancies that match the expertise provided",
  //     schema: z.object({
  //       expertise: z.array(z.string()),
  //     }),
  //   }),
  // )
  .from(simple({ expertise: ["Java"] }))
  .enrich((e) => ({
    url: `https://www.sourcepower.nl/opdrachten/?_sf_s=${e.body.expertise.join(",")}`,
  }))
  .enrich(mcp("browser:browser_navigate"))
  .enrich(
    mcp("browser:browser_evaluate", {
      args: () => ({ script: EXTRACT_MEER_INFO_LINKS_SCRIPT }),
    }),
  )
  // silly way to extract links from the browser evaluate result, but it works
  .enrich(
    llm("ollama:qwen3:0.6b", {
      systemPrompt:
        'You receive text that may contain an \'Execution result:\' prefix followed by a JSON array of URL strings. Extract all links and respond with only a valid JSON array of strings, e.g. ["https://example.com/a", "https://example.com/b"]. No other text or markdown.',
      userPrompt: (e) => e.body.value,
      outputSchema: z.object({
        links: z.array(z.string()),
      }),
    }),
  )
  .tap(log((e) => JSON.parse(e.body.content)));
