import type { ResearchSource } from "../citations/research-source";

export interface ResearchQuery {
  query: string;
  limit?: number;
}

export interface ResearchProvider {
  readonly name: string;

  search(query: ResearchQuery): Promise<ResearchSource[]>;
}
