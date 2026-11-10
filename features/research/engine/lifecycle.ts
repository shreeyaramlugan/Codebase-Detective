// features/research/engine/lifecycle.ts
//
// Recommendation lifecycle. "Implemented" is a user-managed status only: the
// platform never infers it from code and never changes code itself.
export const RECOMMENDATION_STATUSES = [
  "PROPOSED",
  "ACCEPTED",
  "REJECTED",
  "IMPLEMENTED",
  "ARCHIVED",
] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

const ALLOWED: Record<RecommendationStatus, RecommendationStatus[]> = {
  PROPOSED: ["ACCEPTED", "REJECTED", "ARCHIVED"],
  ACCEPTED: ["PROPOSED", "REJECTED", "IMPLEMENTED", "ARCHIVED"],
  REJECTED: ["PROPOSED", "ARCHIVED"],
  IMPLEMENTED: ["ACCEPTED", "ARCHIVED"],
  ARCHIVED: ["PROPOSED"],
};

export function isRecommendationStatus(value: unknown): value is RecommendationStatus {
  return typeof value === "string" && (RECOMMENDATION_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: RecommendationStatus, to: RecommendationStatus): boolean {
  return from !== to && ALLOWED[from].includes(to);
}

export const MAX_NOTE_CHARS = 1_000;
export function validateNote(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_NOTE_CHARS) throw new Error("Invalid note.");
  return value.trim() || null;
}
