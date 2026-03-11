import Exa from "exa-js";
import { logger } from "../utils/logger.js";
import type { WebSearchResult } from "../types/index.js";

/**
 * Search using Exa's neural search engine.
 * Returns semantically relevant results with highlighted excerpts.
 */
export async function exaSearch(
  query: string,
  apiKey: string,
  options: {
    numResults?: number;
    type?: "neural" | "keyword" | "auto";
  } = {}
): Promise<WebSearchResult[]> {
  const { numResults = 6, type = "auto" } = options;

  try {
    const exa = new Exa(apiKey);

    const response = await exa.searchAndContents(query, {
      type,
      numResults,
      highlights: {
        numSentences: 3,
        highlightsPerUrl: 2,
      },
      text: { maxCharacters: 400 },
    });

    const results: WebSearchResult[] = [];

    for (const result of response.results) {
      // Use highlights if available, fall back to text excerpt
      const highlights = result.highlights?.join(" … ") ?? "";
      const snippet =
        highlights ||
        (result.text ? result.text.slice(0, 400) : "No content available");

      results.push({
        title: result.title ?? query,
        url: result.url,
        snippet,
      });
    }

    logger.debug(`Exa returned ${results.length} results for: ${query}`);
    return results;
  } catch (error) {
    logger.warn("Exa search failed:", error);
    throw error;
  }
}
