import type {
  ResearchProvider,
  ResearchQuery,
} from "./research-provider";

import type {
  ResearchSource,
} from "../citations/research-source";

export class DocumentationProvider
  implements ResearchProvider
{
  readonly name = "official-documentation";

  private readonly sources: ResearchSource[];

  constructor(sources: ResearchSource[] = []) {
    this.sources = sources;
  }

  async search(
    query: ResearchQuery,
  ): Promise<ResearchSource[]> {
    const searchTerms = query.query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    const results = this.sources.filter((source) => {
      const content =
        `${source.title} ${source.excerpt}`.toLowerCase();

      return searchTerms.every((term) =>
        content.includes(term),
      );
    });

    return results.slice(0, query.limit ?? 5);
  }
}