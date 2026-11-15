import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { validateProductionEnv } from "@/lib/config/production-env";
import { loadWorkerConfig } from "@/lib/worker/config";

const good = {
  DATABASE_URL: "postgresql://u:p@host/db?sslmode=require",
  SOURCE_STORAGE_PROVIDER: "s3",
  S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  S3_BUCKET: "b",
  S3_ACCESS_KEY_ID: "id",
  S3_SECRET_ACCESS_KEY: "secret",
  AI_PROVIDER: "gemini",
  GEMINI_API_KEY: "key",
  GITHUB_TOKEN: "t",
  RESEARCH_CONTACT_EMAIL: "a@b.co",
  BETTER_AUTH_SECRET: "x".repeat(40),
  BETTER_AUTH_URL: "https://app.example.com",
  NEXT_PUBLIC_APP_URL: "https://app.example.com",
  GITHUB_CLIENT_ID: "cid",
  GITHUB_CLIENT_SECRET: "csecret",
};

describe("validateProductionEnv", () => {
  it("accepts a complete web and worker environment", () => {
    expect(validateProductionEnv(good, "web").errors).toEqual([]);
    expect(validateProductionEnv(good, "worker").errors).toEqual([]);
  });

  it("rejects local storage, localhost auth URLs and placeholder secrets", () => {
    const report = validateProductionEnv(
      {
        ...good,
        SOURCE_STORAGE_PROVIDER: "local",
        BETTER_AUTH_URL: "http://localhost:3000",
        BETTER_AUTH_SECRET: "GENERATE_A_RANDOM_SECRET",
      },
      "web",
    );
    const text = report.errors.join("\n");
    expect(text).toContain("SOURCE_STORAGE_PROVIDER");
    expect(text).toContain("BETTER_AUTH_URL");
    expect(text).toContain("BETTER_AUTH_SECRET");
  });

  it("flags missing S3 credentials and inline background execution", () => {
    const report = validateProductionEnv(
      { ...good, S3_SECRET_ACCESS_KEY: "", BACKGROUND_EXECUTION: "inline" },
      "worker",
    );
    expect(report.errors.join("\n")).toContain("S3_SECRET_ACCESS_KEY");
    expect(report.errors.join("\n")).toContain("BACKGROUND_EXECUTION");
  });

  it("warns, without failing, about optional settings", () => {
    const report = validateProductionEnv({ ...good, GITHUB_TOKEN: "", AI_PROVIDER: "mock" }, "web");
    expect(report.errors).toEqual([]);
    expect(report.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("never includes secret values in messages", () => {
    const report = validateProductionEnv({ ...good, BETTER_AUTH_SECRET: "short-secret-value" }, "web");
    expect(JSON.stringify(report)).not.toContain("short-secret-value");
  });
});

describe("worker configuration with durable storage", () => {
  const base = { DATABASE_URL: "postgresql://x", NODE_ENV: "production" } as Record<string, string>;

  it("refuses local storage in production", () => {
    expect(() => loadWorkerConfig({ ...base, SOURCE_STORAGE_PROVIDER: "local" })).toThrowError(/not allowed in production/);
  });

  it("requires S3 settings when s3 is selected", () => {
    expect(() => loadWorkerConfig({ ...base, SOURCE_STORAGE_PROVIDER: "s3" })).toThrowError(/S3_ENDPOINT/);
  });

  it("accepts a complete s3 configuration", () => {
    expect(() =>
      loadWorkerConfig({
        ...base,
        SOURCE_STORAGE_PROVIDER: "s3",
        S3_ENDPOINT: "https://x.example.com",
        S3_BUCKET: "b",
        S3_ACCESS_KEY_ID: "i",
        S3_SECRET_ACCESS_KEY: "s",
      }),
    ).not.toThrow();
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("storage credential boundaries", () => {
  const root = process.cwd();
  it("the S3 secret is only read by the storage factory and client code never sees it", () => {
    const readers = [...walk(join(root, "lib")), ...walk(join(root, "features")), ...walk(join(root, "app"))]
      .filter((f) => /process\.env\.S3_SECRET_ACCESS_KEY|\bS3_SECRET_ACCESS_KEY\b/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1).split("\\").join("/"))
      .sort();
    // the factory reads it; the adapter names it in errors; worker config and the env checker only test presence.
    expect(readers).toEqual([
      "lib/config/production-env.ts",
      "lib/ingestion/storage/s3-storage.adapter.ts",
      "lib/ingestion/storage/storage.factory.ts",
      "lib/worker/config.ts",
    ]);
    for (const file of walk(join(root, "components"))) {
      expect(readFileSync(file, "utf8")).not.toContain("S3_");
    }
  });
});
