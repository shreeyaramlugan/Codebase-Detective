export type ResearchSourceType =
  | "official_documentation"
  | "academic";

export interface ResearchSource {
  id: string;
  type: ResearchSourceType;

  title: string;
  url: string;
  publisher: string;

  excerpt: string;

  retrievedAt: string;
  publishedAt?: string;

  authors?: string[];
  doi?: string;
}