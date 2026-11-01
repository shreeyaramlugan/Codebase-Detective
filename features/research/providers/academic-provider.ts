import type {
  ResearchProvider,
  ResearchQuery,
} from "./research-provider";

import type {
  ResearchSource,
} from "../citations/research-source";

export interface AcademicSearchAdapter {
  search(
    query: ResearchQuery,
  ): Promise<ResearchSource[]>;
}

export class AcademicProvider
  implements ResearchProvider
{
  readonly name = "academic";

  constructor(
    private readonly adapter: AcademicSearchAdapter,
  ) {}

  async search(
    query: ResearchQuery,
  ): Promise<ResearchSource[]> {
    if (!query.query.trim()) {
      return [];
    }

    return this.adapter.search({
      query: query.query.trim(),
      limit: query.limit ?? 5,
    });
  }
}