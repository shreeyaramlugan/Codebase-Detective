import type { ResearchSource } from "./research-source";

export function validateResearchSource(source: ResearchSource): boolean {
  try {
    const url = new URL(source.url);

    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      Boolean(source.id.trim()) &&
      Boolean(source.title.trim()) &&
      Boolean(source.publisher.trim()) &&
      Boolean(source.excerpt.trim()) &&
      !Number.isNaN(Date.parse(source.retrievedAt))
    );
  } catch {
    return false;
  }
}
