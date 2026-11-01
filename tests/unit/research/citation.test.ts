import { describe, expect, it } from "vitest";

import { validateResearchSource } from "../../../features/research/citations";

import type {
  ResearchSource,
} from "../../../features/research/citations";

const validSource: ResearchSource = {
  id: "DOC-001",
  type: "official_documentation",
  title: "TypeScript Documentation",
  url: "https://www.typescriptlang.org/docs/",
  publisher: "Microsoft",
  excerpt: "Official documentation.",
  retrievedAt: "2026-11-01T10:00:00.000Z",
};

describe("Research citation validation", () => {
  it("accepts valid source metadata", () => {
    expect(validateResearchSource(validSource)).toBe(true);
  });

  it("rejects invalid URLs", () => {
    expect(
      validateResearchSource({
        ...validSource,
        url: "not-a-url",
      }),
    ).toBe(false);
  });

  it("rejects missing titles", () => {
    expect(
      validateResearchSource({
        ...validSource,
        title: "",
      }),
    ).toBe(false);
  });

  it("rejects invalid retrieval dates", () => {
    expect(
      validateResearchSource({
        ...validSource,
        retrievedAt: "not-a-date",
      }),
    ).toBe(false);
  });
});