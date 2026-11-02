import { describe, expect, it, vi } from "vitest";
import {
  AcademicProvider,
  type AcademicSearchAdapter,
} from "@/features/research/providers/academic-provider";

describe("AcademicProvider", () => {
  it("identifies itself as the academic provider", () => {
    const adapter: AcademicSearchAdapter = {
      search: vi.fn().mockResolvedValue([]),
    };

    const provider = new AcademicProvider(adapter);

    expect(provider.name).toBe("academic");
  });

  it("trims the search query before calling the adapter", async () => {
    const adapter: AcademicSearchAdapter = {
      search: vi.fn().mockResolvedValue([]),
    };

    const provider = new AcademicProvider(adapter);

    await provider.search({ query: "  TypeScript security  " });

    expect(adapter.search).toHaveBeenCalledWith({
      query: "TypeScript security",
      limit: 5,
    });
  });

  it("uses the default limit of 5 when no limit is supplied", async () => {
    const adapter: AcademicSearchAdapter = {
      search: vi.fn().mockResolvedValue([]),
    };

    const provider = new AcademicProvider(adapter);

    await provider.search({ query: "React security" });

    expect(adapter.search).toHaveBeenCalledWith({
      query: "React security",
      limit: 5,
    });
  });

  it("preserves a custom result limit", async () => {
    const adapter: AcademicSearchAdapter = {
      search: vi.fn().mockResolvedValue([]),
    };

    const provider = new AcademicProvider(adapter);

    await provider.search({
      query: "dependency vulnerabilities",
      limit: 10,
    });

    expect(adapter.search).toHaveBeenCalledWith({
      query: "dependency vulnerabilities",
      limit: 10,
    });
  });

  it("preserves a limit of zero instead of applying the default", async () => {
    const adapter: AcademicSearchAdapter = {
      search: vi.fn().mockResolvedValue([]),
    };

    const provider = new AcademicProvider(adapter);

    await provider.search({
      query: "security",
      limit: 0,
    });

    expect(adapter.search).toHaveBeenCalledWith({
      query: "security",
      limit: 0,
    });
  });

  it("returns an empty array for a blank query", async () => {
    const adapter: AcademicSearchAdapter = {
      search: vi.fn().mockResolvedValue([]),
    };

    const provider = new AcademicProvider(adapter);

    const result = await provider.search({ query: "" });

    expect(result).toEqual([]);
    expect(adapter.search).not.toHaveBeenCalled();
  });

  it("returns an empty array for a whitespace-only query", async () => {
    const adapter: AcademicSearchAdapter = {
      search: vi.fn().mockResolvedValue([]),
    };

    const provider = new AcademicProvider(adapter);

    const result = await provider.search({ query: "   \t\n " });

    expect(result).toEqual([]);
    expect(adapter.search).not.toHaveBeenCalled();
  });

  it("returns the results supplied by the adapter", async () => {
    const results = [{ id: "source-1" }, { id: "source-2" }];

    const adapter: AcademicSearchAdapter = {
      search: vi.fn().mockResolvedValue(results),
    };

    const provider = new AcademicProvider(adapter);

    const result = await provider.search({
      query: "software security",
    });

    expect(result).toBe(results);
  });

  it("propagates adapter errors to the caller", async () => {
    const error = new Error("Academic search failed");

    const adapter: AcademicSearchAdapter = {
      search: vi.fn().mockRejectedValue(error),
    };

    const provider = new AcademicProvider(adapter);

    await expect(
      provider.search({ query: "software security" }),
    ).rejects.toThrow("Academic search failed");
  });
});
