import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { S3StorageAdapter } from "@/lib/ingestion/storage/s3-storage.adapter";
import { createSourceStorageAdapter } from "@/lib/ingestion/storage/storage.factory";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
}

function fakeS3(options: { failStatus?: number; corrupt?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      method: String(init.method),
      url,
      headers: init.headers as Record<string, string>,
    });
    if (options.failStatus) return new Response("secret-detail", { status: options.failStatus });
    const key = new URL(url).pathname;
    switch (init.method) {
      case "PUT":
        objects.set(key, Buffer.from(init.body as Uint8Array));
        return new Response(null, { status: 200 });
      case "GET": {
        const found = objects.get(key);
        if (!found) return new Response("nope", { status: 404 });
        return new Response(new Uint8Array(options.corrupt ? Buffer.from("tampered") : found), { status: 200 });
      }
      case "HEAD":
        return new Response(null, { status: objects.has(key) ? 200 : 404 });
      case "DELETE":
        objects.delete(key);
        return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 400 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, objects };
}

function adapter(fetchImpl: typeof fetch, extra = {}) {
  return new S3StorageAdapter({
    endpoint: "https://acct.r2.cloudflarestorage.com",
    region: "auto",
    bucket: "snapshots",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "SECRETEXAMPLE",
    fetchImpl,
    now: () => new Date("2026-11-15T10:00:00Z"),
    ...extra,
  });
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("S3StorageAdapter", () => {
  it("stores and retrieves an object with hash verification", async () => {
    const { fetchImpl } = fakeS3();
    const s3 = adapter(fetchImpl);
    const content = Buffer.from("export const a = 1;");
    const stored = await s3.put(content);
    expect(stored.contentHash).toBe(sha(content));
    expect(stored.sizeBytes).toBe(content.byteLength);
    expect(await s3.exists(stored.storageKey)).toBe(true);
    expect((await s3.get(stored.storageKey, stored.contentHash)).toString()).toBe(content.toString());
  });

  it("signs requests with SigV4 and never sends the secret", async () => {
    const { fetchImpl, calls } = fakeS3();
    await adapter(fetchImpl).put(Buffer.from("x"));
    const headers = calls[0].headers;
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261115\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(headers["x-amz-date"]).toBe("20261115T100000Z");
    expect(headers["x-amz-content-sha256"]).toBe(sha(Buffer.from("x")));
    expect(JSON.stringify(calls)).not.toContain("SECRETEXAMPLE");
    expect(calls[0].url.startsWith("https://acct.r2.cloudflarestorage.com/snapshots/")).toBe(true);
  });

  it("signature is deterministic for identical input and time", async () => {
    const a = fakeS3();
    const b = fakeS3();
    const sa = adapter(a.fetchImpl);
    const sb = adapter(b.fetchImpl);
    await sa.exists("11111111-1111-4111-8111-111111111111");
    await sb.exists("11111111-1111-4111-8111-111111111111");
    expect(a.calls[0].headers.authorization).toBe(b.calls[0].headers.authorization);
  });

  it("supports virtual-hosted style and a key prefix", async () => {
    const { fetchImpl, calls } = fakeS3();
    await adapter(fetchImpl, { forcePathStyle: false, keyPrefix: "/snap/" }).put(Buffer.from("x"));
    expect(calls[0].url).toMatch(/^https:\/\/snapshots\.acct\.r2\.cloudflarestorage\.com\/snap\/[0-9a-f-]{36}$/);
  });

  it("rejects a tampered object with an integrity error", async () => {
    const good = fakeS3();
    const stored = await adapter(good.fetchImpl).put(Buffer.from("original"));
    const bad = fakeS3({ corrupt: true });
    const s3 = adapter(bad.fetchImpl);
    const again = await s3.put(Buffer.from("original"));
    await expect(s3.get(again.storageKey, stored.contentHash)).rejects.toMatchObject({
      code: "INTEGRITY_CHECK_FAILED",
    });
  });

  it("reports a missing object and treats delete of a missing object as success", async () => {
    const s3 = adapter(fakeS3().fetchImpl);
    const key = "22222222-2222-4222-8222-222222222222";
    await expect(s3.get(key, "a".repeat(64))).rejects.toMatchObject({ code: "OBJECT_NOT_FOUND" });
    expect(await s3.exists(key)).toBe(false);
    await expect(s3.delete(key)).resolves.toBeUndefined();
  });

  it("rejects invalid keys and hashes before any network call", async () => {
    const { fetchImpl, calls } = fakeS3();
    const s3 = adapter(fetchImpl);
    await expect(s3.get("../../etc/passwd", "a".repeat(64))).rejects.toMatchObject({ code: "INVALID_STORAGE_KEY" });
    await expect(s3.get("22222222-2222-4222-8222-222222222222", "bad")).rejects.toMatchObject({ code: "INTEGRITY_CHECK_FAILED" });
    expect(calls).toHaveLength(0);
  });

  it("maps provider failures to safe, correctly retryable errors", async () => {
    const s3 = adapter(fakeS3({ failStatus: 503 }).fetchImpl);
    const error = await s3.put(Buffer.from("x")).catch((e) => e);
    expect(error).toMatchObject({ code: "STORAGE_WRITE_FAILED", retryable: true });
    expect(error.message).not.toContain("secret-detail");

    const denied = adapter(fakeS3({ failStatus: 403 }).fetchImpl);
    await expect(denied.put(Buffer.from("x"))).rejects.toMatchObject({ retryable: false });
  });

  it("maps network failures to retryable errors", async () => {
    const s3 = adapter((async () => {
      throw new Error("ECONNRESET https://acct.r2.cloudflarestorage.com");
    }) as unknown as typeof fetch);
    const error = await s3.put(Buffer.from("x")).catch((e) => e);
    expect(error).toMatchObject({ code: "STORAGE_WRITE_FAILED", retryable: true });
    expect(error.message).not.toContain("r2.cloudflarestorage");
  });

  it("validates configuration without leaking values", () => {
    expect(() => adapter(fakeS3().fetchImpl, { bucket: "" })).toThrowError(/S3_BUCKET/);
    expect(() => adapter(fakeS3().fetchImpl, { endpoint: "http://evil.example.com" })).toThrowError(/https/);
    expect(() => adapter(fakeS3().fetchImpl, { endpoint: "not a url" })).toThrowError(/valid URL/);
  });
});

describe("createSourceStorageAdapter (s3)", () => {
  it("selects the S3 adapter", () => {
    const created = createSourceStorageAdapter({
      provider: "s3",
      s3: {
        endpoint: "https://acct.r2.cloudflarestorage.com",
        bucket: "b",
        accessKeyId: "a",
        secretAccessKey: "s",
      },
    });
    expect(created).toBeInstanceOf(S3StorageAdapter);
  });

  it("fails clearly when S3 settings are missing", () => {
    expect(() => createSourceStorageAdapter({ provider: "s3", s3: { endpoint: "", bucket: "" } })).toThrowError(
      expect.objectContaining({ code: "STORAGE_CONFIGURATION_ERROR" }),
    );
  });
});
