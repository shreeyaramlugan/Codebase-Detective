// features/research/engine/identity.ts
//
// Source identity: canonical URLs, DOI normalisation/validation and stable keys.
// A DOI is only ever treated as verified when it came from a provider record.
import { createHash } from "node:crypto";

const TRACKING = /^(utm_|fbclid$|gclid$|mc_|ref$|source$)/i;

/** Canonical form of an http(s) URL, or null when it is not a usable web URL. */
export function canonicalUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  url.protocol = "https:";
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.port === "443" || url.port === "80") url.port = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  let out = url.toString();
  if (url.pathname.length > 1 && out.endsWith("/") && !url.search) {
    out = out.slice(0, -1);
  }
  return out;
}

const DOI_PATTERN = /^10\.\d{4,9}\/[^\s]+$/i;

/** Lower-cased bare DOI ("10.x/y") or null when the value is not DOI-shaped. */
export function normaliseDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let doi = raw.trim();
  doi = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
  try {
    doi = decodeURIComponent(doi);
  } catch {
    /* keep as is */
  }
  doi = doi.trim().replace(/[.,;)\]]+$/, "");
  return DOI_PATTERN.test(doi) ? doi.toLowerCase() : null;
}

export function doiUrl(doi: string): string {
  return `https://doi.org/${doi}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** Stable, content-independent identity. DOI wins over URL so duplicates merge. */
export function sourceKey(input: { doi: string | null; canonicalUrl: string }): string {
  return `src_${hash(input.doi ? `doi:${input.doi}` : `url:${input.canonicalUrl}`)}`;
}

export function contentHash(text: string): string {
  return hash(text.replace(/\s+/g, " ").trim());
}
