// lib/ingestion/storage/s3-storage.adapter.ts
//
// Durable object storage for repository snapshots, for any S3-compatible
// service (Cloudflare R2, Supabase Storage S3 endpoint, Backblaze B2, AWS S3,
// MinIO). It has no SDK dependency: requests are signed with AWS Signature V4
// using node:crypto and sent with fetch. It follows the same contract as the
// local adapter: random UUID keys, SHA-256 verification on read, idempotent
// delete, and no error text that could expose credentials or endpoints.
import { createHash, createHmac, randomUUID } from "node:crypto";

import { StorageError } from "./storage.errors";
import type { SourceStorageAdapter, StoredObject } from "./storage.types";

const STORAGE_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const EMPTY_BODY_HASH = createHash("sha256").update("").digest("hex");
const DEFAULT_TIMEOUT_MS = 30_000;

export interface S3StorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style addressing (https://host/bucket/key). Default true: it works on every provider. */
  forcePathStyle?: boolean;
  /** Optional folder inside the bucket, e.g. "snapshots". */
  keyPrefix?: string;
  timeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC 3986 encoding of one path segment, as SigV4 requires. */
function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export class S3StorageAdapter implements SourceStorageAdapter {
  private readonly url: URL;
  private readonly region: string;
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly forcePathStyle: boolean;
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: S3StorageOptions) {
    const missing = (
      [
        ["S3_ENDPOINT", options.endpoint],
        ["S3_REGION", options.region],
        ["S3_BUCKET", options.bucket],
        ["S3_ACCESS_KEY_ID", options.accessKeyId],
        ["S3_SECRET_ACCESS_KEY", options.secretAccessKey],
      ] as const
    )
      .filter(([, value]) => !value?.trim())
      .map(([name]) => name);

    if (missing.length > 0) {
      throw new StorageError(
        `Object storage is not configured: ${missing.join(", ")} required.`,
        "STORAGE_CONFIGURATION_ERROR",
      );
    }

    let url: URL;
    try {
      url = new URL(options.endpoint.trim());
    } catch {
      throw new StorageError(
        "S3_ENDPOINT is not a valid URL.",
        "STORAGE_CONFIGURATION_ERROR",
      );
    }
    if (url.protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) {
      throw new StorageError(
        "S3_ENDPOINT must use https.",
        "STORAGE_CONFIGURATION_ERROR",
      );
    }

    this.url = url;
    this.region = options.region.trim();
    this.bucket = options.bucket.trim();
    this.accessKeyId = options.accessKeyId.trim();
    this.secretAccessKey = options.secretAccessKey.trim();
    this.forcePathStyle = options.forcePathStyle ?? true;
    this.prefix = (options.keyPrefix ?? "").replace(/^\/+|\/+$/g, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  private validateStorageKey(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new StorageError("Invalid storage key.", "INVALID_STORAGE_KEY");
    }
    return this.prefix ? `${this.prefix}/${storageKey}` : storageKey;
  }

  private target(objectKey: string): { host: string; path: string; url: string } {
    const segments = objectKey.split("/").map(encodeSegment).join("/");
    const basePath = this.url.pathname.replace(/\/+$/, "");
    if (this.forcePathStyle) {
      const path = `${basePath}/${encodeSegment(this.bucket)}/${segments}`;
      return { host: this.url.host, path, url: `${this.url.origin}${path}` };
    }
    const host = `${this.bucket}.${this.url.host}`;
    const path = `${basePath}/${segments}`;
    return { host, path, url: `${this.url.protocol}//${host}${path}` };
  }

  private sign(
    method: string,
    host: string,
    path: string,
    payloadHash: string,
    extraHeaders: Record<string, string>,
  ): Record<string, string> {
    const date = this.now();
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);

    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...extraHeaders,
    };
    const names = Object.keys(headers).map((n) => n.toLowerCase()).sort();
    const canonicalHeaders = names
      .map((n) => `${n}:${String(headers[n]).trim()}\n`)
      .join("");
    const signedHeaders = names.join(";");
    const canonicalRequest = [
      method,
      path,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join("\n");

    const kDate = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning)
      .update(stringToSign)
      .digest("hex");

    return {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }

  private async send(
    method: "GET" | "PUT" | "DELETE" | "HEAD",
    objectKey: string,
    body?: Buffer,
  ): Promise<Response> {
    const { host, path, url } = this.target(objectKey);
    const payloadHash = body ? sha256Hex(body) : EMPTY_BODY_HASH;
    const headers = this.sign(
      method,
      host,
      path,
      payloadHash,
      body ? { "content-type": "application/octet-stream" } : {},
    );
    // fetch sets Host itself.
    delete headers.host;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body: body ? new Uint8Array(body) : undefined,
        signal: controller.signal,
        redirect: "error",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private isRetryable(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
  }

  async put(content: Buffer): Promise<StoredObject> {
    if (!Buffer.isBuffer(content)) {
      throw new StorageError(
        "Storage content must be a Buffer.",
        "STORAGE_WRITE_FAILED",
      );
    }

    const storageKey = randomUUID();
    const objectKey = this.validateStorageKey(storageKey);
    const contentHash = sha256Hex(content);

    let response: Response;
    try {
      response = await this.send("PUT", objectKey, content);
    } catch {
      throw new StorageError(
        "Unable to store source content.",
        "STORAGE_WRITE_FAILED",
        true,
      );
    }
    if (!response.ok) {
      throw new StorageError(
        "Unable to store source content.",
        "STORAGE_WRITE_FAILED",
        this.isRetryable(response.status),
      );
    }

    return { storageKey, contentHash, sizeBytes: content.byteLength };
  }

  async get(storageKey: string, expectedContentHash: string): Promise<Buffer> {
    if (!SHA256_PATTERN.test(expectedContentHash)) {
      throw new StorageError(
        "Invalid expected SHA-256 content hash.",
        "INTEGRITY_CHECK_FAILED",
      );
    }
    const objectKey = this.validateStorageKey(storageKey);

    let response: Response;
    try {
      response = await this.send("GET", objectKey);
    } catch {
      throw new StorageError(
        "Unable to read stored source content.",
        "STORAGE_READ_FAILED",
        true,
      );
    }

    if (response.status === 404) {
      throw new StorageError("Stored object was not found.", "OBJECT_NOT_FOUND");
    }
    if (!response.ok) {
      throw new StorageError(
        "Unable to read stored source content.",
        "STORAGE_READ_FAILED",
        this.isRetryable(response.status),
      );
    }

    let content: Buffer;
    try {
      content = Buffer.from(await response.arrayBuffer());
    } catch {
      throw new StorageError(
        "Unable to read stored source content.",
        "STORAGE_READ_FAILED",
        true,
      );
    }

    if (sha256Hex(content) !== expectedContentHash.toLowerCase()) {
      throw new StorageError(
        "Stored object failed SHA-256 integrity verification.",
        "INTEGRITY_CHECK_FAILED",
      );
    }
    return content;
  }

  async delete(storageKey: string): Promise<void> {
    const objectKey = this.validateStorageKey(storageKey);

    let response: Response;
    try {
      response = await this.send("DELETE", objectKey);
    } catch {
      throw new StorageError(
        "Unable to delete stored source content.",
        "STORAGE_DELETE_FAILED",
        true,
      );
    }
    // S3 returns 204 for missing objects; treat 404 as success as well.
    if (!response.ok && response.status !== 404) {
      throw new StorageError(
        "Unable to delete stored source content.",
        "STORAGE_DELETE_FAILED",
        this.isRetryable(response.status),
      );
    }
  }

  async exists(storageKey: string): Promise<boolean> {
    const objectKey = this.validateStorageKey(storageKey);

    let response: Response;
    try {
      response = await this.send("HEAD", objectKey);
    } catch {
      throw new StorageError(
        "Unable to check stored source content.",
        "STORAGE_READ_FAILED",
        true,
      );
    }
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new StorageError(
        "Unable to check stored source content.",
        "STORAGE_READ_FAILED",
        this.isRetryable(response.status),
      );
    }
    return true;
  }
}
