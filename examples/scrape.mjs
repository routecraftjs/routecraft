import { log, craft } from "@routecraft/routecraft";
import { mcp, mcpPlugin } from "@routecraft/ai";

export const craftConfig = {
  plugins: [
    mcpPlugin({
      name: "routecraft",
      version: "1.0.0",
      transport: "stdio",
      clients: {
        browser: { url: "http://127.0.0.1:8089/mcp" },
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
  .id("scrape")
  .from(
    mcp("get-vacancies", {
      description: "Get vacancies from SourcePower",
    }),
  )
  .enrich(() => ({ url: "https://www.sourcepower.nl/opdrachten/?_sf_s=Java" }))
  .tap(log())
  .enrich(mcp("browser:browser_navigate"))
  .tap(log())
  .enrich(
    mcp("browser:browser_evaluate", {
      args: () => ({
        script: `() => new Promise(r => setTimeout(r, 100))`,
      }),
    }),
  )
  .tap(log())
  .enrich(
    mcp("browser:browser_evaluate", {
      args: () => ({ script: EXTRACT_MEER_INFO_LINKS_SCRIPT }),
    }),
  )
  .tap(log());
