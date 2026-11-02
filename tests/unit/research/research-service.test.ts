import { describe, expect, it, vi } from "vitest";

import { ResearchService } from "../../../features/research/retrieval";
import { DocumentationProvider } from "../../../features/research/providers";

import type { ResearchProvider } from "../../../features/research/providers";

import type { ResearchSource } from "../../../features/research/citations";

const source: ResearchSource = {
  id: "DOC-001",
  type: "official_documentation",
  title: "TypeScript Documentation",
  url: "https://www.typescriptlang.org/docs/",
  publisher: "Microsoft",
  excerpt: "Official TypeScript documentation.",
  retrievedAt: "2026-11-01T10:00:00.000Z",
};

describe("ResearchService", () => {
  it("retrieves matching documentation", async () => {
    const provider = new DocumentationProvider([source]);

    const results = await provider.search({
      query: "TypeScript documentation",
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("DOC-001");
  });

  it("deduplicates sources by URL", async () => {
    const providerA: ResearchProvider = {
      name: "provider-a",
      search: vi.fn().mockResolvedValue([source]),
    };

    const providerB: ResearchProvider = {
      name: "provider-b",
      search: vi.fn().mockResolvedValue([source]),
    };

    const service = new ResearchService([providerA, providerB]);

    const results = await service.search({
      query: "TypeScript",
    });

    expect(results).toHaveLength(1);
  });

  it("continues when a provider fails", async () => {
    const failingProvider: ResearchProvider = {
      name: "failing",
      search: vi.fn().mockRejectedValue(new Error("Provider unavailable")),
    };

    const workingProvider: ResearchProvider = {
      name: "working",
      search: vi.fn().mockResolvedValue([source]),
    };

    const service = new ResearchService([failingProvider, workingProvider]);

    const results = await service.search({
      query: "TypeScript",
    });

    expect(results).toHaveLength(1);
  });

  it("returns no results for an empty query", async () => {
    const provider: ResearchProvider = {
      name: "test",
      search: vi.fn(),
    };

    const service = new ResearchService([provider]);

    const results = await service.search({
      query: "   ",
    });

    expect(results).toEqual([]);
    expect(provider.search).not.toHaveBeenCalled();
  });
});
