// features/research/engine/http.ts
//
// Bounded, SSRF-conscious HTTP for research retrieval: timeouts, byte caps,
// manual redirects with the host policy re-applied at every hop, no cookies,
// no credentials, and never any automatic retry.
export type FetchLike = typeof fetch;

export class ResearchHttpError extends Error {
  constructor(
    message: string,
    readonly code:
      | "TIMEOUT"
      | "RATE_LIMITED"
      | "NOT_FOUND"
      | "FORBIDDEN_HOST"
      | "TOO_LARGE"
      | "BAD_CONTENT"
      | "UNAVAILABLE",
    readonly status?: number,
  ) {
    super(message);
    this.name = "ResearchHttpError";
  }
}

export const USER_AGENT =
  "CodebaseDetective-Research/1.0 (+documentation and scholarly lookup; low volume)";

const PRIVATE_HOST =
  /^(localhost|.*\.local|.*\.internal|.*\.localhost)$|^\d{1,3}(\.\d{1,3}){3}$|^\[|:/;

/** Rejects IP literals and local names; allow-lists are applied by callers. */
export function isPublicHostname(host: string): boolean {
  return host.length > 3 && host.includes(".") && !PRIVATE_HOST.test(host.toLowerCase());
}

export interface FetchOptions {
  fetchImpl: FetchLike;
  timeoutMs: number;
  maxBytes: number;
  accept: string;
  /** Called with each hop's URL; return false to refuse it. */
  hostAllowed: (url: URL) => boolean;
  maxRedirects?: number;
}

export interface FetchedBody {
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
  redirected: boolean;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > maxBytes) throw new ResearchHttpError("Body too large.", "TOO_LARGE");
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResearchHttpError("Body too large.", "TOO_LARGE");
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(
    Buffer.concat(chunks.map((c) => Buffer.from(c))),
  );
}

export async function fetchBounded(
  startUrl: string,
  options: FetchOptions,
): Promise<FetchedBody> {
  let url = new URL(startUrl);
  const maxRedirects = options.maxRedirects ?? 3;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (url.protocol !== "https:" || !isPublicHostname(url.hostname) || !options.hostAllowed(url)) {
      throw new ResearchHttpError("Host is not permitted.", "FORBIDDEN_HOST");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response;
    try {
      response = await options.fetchImpl(url.toString(), {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers: { accept: options.accept, "user-agent": USER_AGENT },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted =
        controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      throw new ResearchHttpError(
        aborted ? "Request timed out." : "Request failed.",
        aborted ? "TIMEOUT" : "UNAVAILABLE",
      );
    }

    try {
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new ResearchHttpError("Bad redirect.", "UNAVAILABLE", response.status);
        url = new URL(location, url);
        continue;
      }
      if (response.status === 429) {
        throw new ResearchHttpError("Rate limited.", "RATE_LIMITED", 429);
      }
      if (response.status === 404 || response.status === 410) {
        throw new ResearchHttpError("Not found.", "NOT_FOUND", response.status);
      }
      if (!response.ok) {
        throw new ResearchHttpError("Provider error.", "UNAVAILABLE", response.status);
      }
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const text = await readCapped(response, options.maxBytes);
      return {
        finalUrl: url.toString(),
        status: response.status,
        contentType,
        text,
        redirected: hop > 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ResearchHttpError("Too many redirects.", "UNAVAILABLE");
}
