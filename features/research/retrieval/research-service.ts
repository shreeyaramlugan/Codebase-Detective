import type {
  ResearchProvider,
  ResearchQuery,
} from "../providers/research-provider";

import type {
  ResearchSource,
} from "../citations/research-source";

export class ResearchService {
  constructor(
    private readonly providers: ResearchProvider[],
  ) {}

  async search(
    query: ResearchQuery,
  ): Promise<ResearchSource[]> {
    if (!query.query.trim()) {
      return [];
    }

    const results = await Promise.all(
      this.providers.map((provider) =>
        provider.search(query).catch(() => []),
      ),
    );

    const uniqueSources = new Map<string, ResearchSource>();

    for (const sources of results) {
      for (const source of sources) {
        if (!uniqueSources.has(source.url)) {
          uniqueSources.set(source.url, source);
        }
      }
    }

    return Array.from(uniqueSources.values()).slice(
      0,
      query.limit ?? 10,
    );
  }
}