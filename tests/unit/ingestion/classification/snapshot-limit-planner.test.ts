import { describe, expect, it } from "vitest";
import type { FileClassificationResult } from "@/lib/ingestion/classification/classification.types";
import { planSnapshotFiles } from "@/lib/ingestion/classification/snapshot-limit-planner";
import { INGESTION_LIMITS } from "@/lib/ingestion/classification/ingestion-limits";

function createEligibleFile(
  path: string,
  sizeBytes: number,
): FileClassificationResult {
  return {
    path,
    name: path.split("/").pop() ?? path,
    extension: ".ts",
    status: "ELIGIBLE",
    category: "SOURCE",
    reason: null,
    gitBlobSha: "a".repeat(40),
    sizeBytes,
  };
}

function createSkippedFile(path: string): FileClassificationResult {
  return {
    path,
    name: path.split("/").pop() ?? path,
    extension: ".png",
    status: "SKIPPED",
    category: null,
    reason: "UNSUPPORTED_FILE_TYPE",
    gitBlobSha: "b".repeat(40),
    sizeBytes: 100,
  };
}

describe("planSnapshotFiles", () => {
  describe("file count limits", () => {
    it("admits files up to the maximum eligible file count", () => {
      const input = Array.from(
        { length: INGESTION_LIMITS.MAX_ELIGIBLE_FILES },
        (_, index) => createEligibleFile(`src/file-${index}.ts`, 1),
      );

      const result = planSnapshotFiles(input);

      expect(result.eligibleFiles).toBe(INGESTION_LIMITS.MAX_ELIGIBLE_FILES);
      expect(result.skippedByFileLimit).toBe(0);
    });

    it("skips files exceeding the maximum eligible file count", () => {
      const input = Array.from(
        { length: INGESTION_LIMITS.MAX_ELIGIBLE_FILES + 1 },
        (_, index) => createEligibleFile(`src/file-${index}.ts`, 1),
      );

      const result = planSnapshotFiles(input);

      expect(result.eligibleFiles).toBe(INGESTION_LIMITS.MAX_ELIGIBLE_FILES);
      expect(result.skippedByFileLimit).toBe(1);

      const skipped = result.files.filter(
        (file) => file.reason === "SNAPSHOT_FILE_LIMIT",
      );

      expect(skipped).toHaveLength(1);
    });
  });

  describe("snapshot content size limits", () => {
    it("admits content exactly at the snapshot size limit", () => {
      const result = planSnapshotFiles([
        createEligibleFile(
          "src/large.ts",
          INGESTION_LIMITS.MAX_SNAPSHOT_SIZE_BYTES,
        ),
      ]);

      expect(result.eligibleFiles).toBe(1);
      expect(result.plannedBytes).toBe(
        INGESTION_LIMITS.MAX_SNAPSHOT_SIZE_BYTES,
      );
      expect(result.skippedBySizeLimit).toBe(0);
    });

    it("skips a file that would exceed the snapshot size limit", () => {
      const result = planSnapshotFiles([
        createEligibleFile(
          "src/first.ts",
          INGESTION_LIMITS.MAX_SNAPSHOT_SIZE_BYTES,
        ),
        createEligibleFile("src/second.ts", 1),
      ]);

      expect(result.eligibleFiles).toBe(1);
      expect(result.skippedBySizeLimit).toBe(1);
      expect(result.plannedBytes).toBe(
        INGESTION_LIMITS.MAX_SNAPSHOT_SIZE_BYTES,
      );

      expect(
        result.files.find((file) => file.path === "src/second.ts")?.reason,
      ).toBe("SNAPSHOT_SIZE_LIMIT");
    });

    it("continues considering later smaller files after a size rejection", () => {
      const result = planSnapshotFiles([
        createEligibleFile(
          "src/a.ts",
          INGESTION_LIMITS.MAX_SNAPSHOT_SIZE_BYTES,
        ),
        createEligibleFile("src/b.ts", 1),
        createEligibleFile("src/c.ts", 0),
      ]);

      expect(result.eligibleFiles).toBe(2);
      expect(result.skippedBySizeLimit).toBe(1);
      expect(result.plannedBytes).toBe(
        INGESTION_LIMITS.MAX_SNAPSHOT_SIZE_BYTES,
      );
    });
  });

  describe("deterministic ordering", () => {
    it("plans files in path order regardless of input order", () => {
      const input = [
        createEligibleFile("src/z.ts", 10),
        createEligibleFile("src/a.ts", 10),
        createEligibleFile("src/m.ts", 10),
      ];

      const result = planSnapshotFiles(input);

      expect(
        result.files
          .filter((file) => file.status === "ELIGIBLE")
          .map((file) => file.path),
      ).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
    });

    it("produces the same admitted files for different input orders", () => {
      const files = [
        createEligibleFile("src/z.ts", 10),
        createEligibleFile("src/a.ts", 10),
        createEligibleFile("src/m.ts", 10),
      ];

      const first = planSnapshotFiles(files);
      const second = planSnapshotFiles([...files].reverse());

      const firstPaths = first.files
        .filter((file) => file.status === "ELIGIBLE")
        .map((file) => file.path);

      const secondPaths = second.files
        .filter((file) => file.status === "ELIGIBLE")
        .map((file) => file.path);

      expect(firstPaths).toEqual(secondPaths);
      expect(first.plannedBytes).toBe(second.plannedBytes);
    });
  });

  describe("invalid file sizes", () => {
    it.each([
      ["null", null],
      ["negative", -1],
      ["fractional", 1.5],
      ["NaN", Number.NaN],
      ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ])("rejects %s file sizes", (_label, sizeBytes) => {
      const file = createEligibleFile("src/invalid.ts", 1);
      file.sizeBytes = sizeBytes;

      const result = planSnapshotFiles([file]);

      expect(result.files[0]).toMatchObject({
        status: "SKIPPED",
        reason: "INVALID_FILE_SIZE",
        category: null,
      });
    });
  });

  describe("preservation and immutability", () => {
    it("preserves files already skipped by classification", () => {
      const skipped = createSkippedFile("assets/logo.png");

      const result = planSnapshotFiles([skipped]);

      expect(result.files[0]).toEqual(skipped);
    });

    it("does not mutate the input array or its file objects", () => {
      const input = [
        createEligibleFile("src/index.ts", 100),
        createSkippedFile("assets/logo.png"),
      ];

      const original = structuredClone(input);

      planSnapshotFiles(input);

      expect(input).toEqual(original);
    });

    it("reports the correct planned byte total", () => {
      const result = planSnapshotFiles([
        createEligibleFile("src/a.ts", 100),
        createEligibleFile("src/b.ts", 200),
        createEligibleFile("src/c.ts", 300),
      ]);

      expect(result.plannedBytes).toBe(600);
    });

    it("does not count invalid sizes as file-limit or size-limit rejections", () => {
      const invalid = createEligibleFile("src/invalid.ts", 1);
      invalid.sizeBytes = null;

      const result = planSnapshotFiles([invalid]);

      expect(result.skippedByFileLimit).toBe(0);
      expect(result.skippedBySizeLimit).toBe(0);
    });
  });
});
