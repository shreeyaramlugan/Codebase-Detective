// features/research/engine/providers/official-docs.ts
//
// Official documentation discovery (hybrid):
//   1. a curated registry of official publishers (host allow-list) with topic
//      entry points,
//   2. the MDN Web Docs search API,
//   3. a `DocumentationSearchPort` for future search providers.
// Candidates are only *candidates*: a page becomes a source with content only
// after it has been fetched from an allow-listed host (redirect hops included),
// robots.txt permitting. A search hit or curated link is never treated as
// retrieved documentation. Pages that cannot be fetched are recorded as
// UNAVAILABLE (metadata only) so the user can see what was attempted.
import type { QueryPlan, SourceRecord } from "../contracts";
import { EXCERPT_CACHE_CHARS } from "../contracts";
import { extractPassages, keywords, parseHtmlPage } from "../html";
import { ResearchHttpError, fetchBounded, type FetchLike } from "../http";
import { canonicalUrl, contentHash, sourceKey } from "../identity";
import { MinIntervalLimiter } from "../rate-limit";
import { emptyDiagnostic, type DiscoveredSource, type DiscoveryContext, type ProviderResult, type SourceProvider } from "./types";

export interface OfficialPublisher {
  id: string;
  name: string;
  hosts: string[];
}

export const OFFICIAL_PUBLISHERS: OfficialPublisher[] = [
  { id: "typescript", name: "TypeScript (Microsoft)", hosts: ["www.typescriptlang.org"] },
  { id: "mdn", name: "MDN Web Docs (Mozilla)", hosts: ["developer.mozilla.org"] },
  { id: "nodejs", name: "Node.js", hosts: ["nodejs.org"] },
  { id: "react", name: "React", hosts: ["react.dev"] },
  { id: "nextjs", name: "Next.js (Vercel)", hosts: ["nextjs.org"] },
  { id: "postgresql", name: "PostgreSQL Global Development Group", hosts: ["www.postgresql.org"] },
  { id: "owasp", name: "OWASP", hosts: ["owasp.org", "cheatsheetseries.owasp.org"] },
];

export interface CuratedEntry {
  url: string;
  title: string;
  publisher: string;
  topics: string[];
}

const OWASP = "https://cheatsheetseries.owasp.org/cheatsheets";

export const CURATED_ENTRIES: CuratedEntry[] = [
  { url: "https://www.typescriptlang.org/docs/handbook/2/modules.html", title: "TypeScript Handbook: Modules", publisher: "typescript", topics: ["module", "modules", "import", "export", "circular", "cycle", "dependency", "dependencies", "coupling"] },
  { url: "https://www.typescriptlang.org/docs/handbook/modules/reference.html", title: "TypeScript Handbook: Modules reference", publisher: "typescript", topics: ["module", "resolution", "import", "specifier", "paths", "alias", "extension", "unresolved"] },
  { url: "https://www.typescriptlang.org/tsconfig", title: "TSConfig Reference", publisher: "typescript", topics: ["tsconfig", "paths", "baseurl", "moduleresolution", "alias", "configuration", "resolution", "unresolved", "import"] },
  { url: "https://nodejs.org/api/modules.html", title: "Node.js: CommonJS modules", publisher: "nodejs", topics: ["commonjs", "require", "module", "cycles", "circular", "cycle", "resolution", "cache", "dependency"] },
  { url: "https://nodejs.org/api/esm.html", title: "Node.js: ECMAScript modules", publisher: "nodejs", topics: ["esm", "import", "export", "module", "resolution", "specifier", "extension", "unresolved"] },
  { url: "https://nodejs.org/api/child_process.html", title: "Node.js: Child process", publisher: "nodejs", topics: ["child_process", "exec", "spawn", "shell", "command", "injection"] },
  { url: "https://nodejs.org/api/crypto.html", title: "Node.js: Crypto", publisher: "nodejs", topics: ["crypto", "hash", "md5", "sha1", "weak", "hashing", "digest"] },
  { url: "https://nodejs.org/api/tls.html", title: "Node.js: TLS/SSL", publisher: "nodejs", topics: ["tls", "ssl", "rejectunauthorized", "certificate", "verification"] },
  { url: "https://nodejs.org/api/vm.html", title: "Node.js: VM (executing JavaScript)", publisher: "nodejs", topics: ["eval", "vm", "dynamic", "code", "function", "sandbox"] },
  { url: "https://react.dev/reference/react-dom/components/common", title: "React: Common components (dangerouslySetInnerHTML)", publisher: "react", topics: ["dangerouslysetinnerhtml", "innerhtml", "xss", "html", "injection"] },
  { url: "https://react.dev/learn/thinking-in-react", title: "React: Thinking in React", publisher: "react", topics: ["component", "components", "structure", "separation", "concerns", "complexity", "large"] },
  { url: "https://nextjs.org/docs", title: "Next.js Documentation", publisher: "nextjs", topics: ["nextjs", "next", "app", "router", "routing", "server", "rendering"] },
  { url: "https://www.postgresql.org/docs/current/", title: "PostgreSQL Documentation (current)", publisher: "postgresql", topics: ["postgresql", "postgres", "sql", "database", "query", "index"] },
  { url: "https://owasp.org/Top10/", title: "OWASP Top 10", publisher: "owasp", topics: ["owasp", "security", "vulnerability", "vulnerabilities", "top10", "risk"] },
  { url: `${OWASP}/Cross_Site_Scripting_Prevention_Cheat_Sheet.html`, title: "OWASP: Cross Site Scripting Prevention Cheat Sheet", publisher: "owasp", topics: ["xss", "html", "innerhtml", "dangerouslysetinnerhtml", "injection", "escaping", "sanitize"] },
  { url: `${OWASP}/Injection_Prevention_Cheat_Sheet.html`, title: "OWASP: Injection Prevention Cheat Sheet", publisher: "owasp", topics: ["injection", "eval", "dynamic", "code", "command", "input"] },
  { url: `${OWASP}/OS_Command_Injection_Defense_Cheat_Sheet.html`, title: "OWASP: OS Command Injection Defense Cheat Sheet", publisher: "owasp", topics: ["command", "injection", "shell", "exec", "child_process", "spawn"] },
  { url: `${OWASP}/Cryptographic_Storage_Cheat_Sheet.html`, title: "OWASP: Cryptographic Storage Cheat Sheet", publisher: "owasp", topics: ["crypto", "cryptographic", "hash", "md5", "sha1", "weak", "encryption", "storage"] },
  { url: `${OWASP}/Password_Storage_Cheat_Sheet.html`, title: "OWASP: Password Storage Cheat Sheet", publisher: "owasp", topics: ["password", "hash", "hashing", "md5", "sha1", "credential", "credentials"] },
  { url: `${OWASP}/Secrets_Management_Cheat_Sheet.html`, title: "OWASP: Secrets Management Cheat Sheet", publisher: "owasp", topics: ["secret", "secrets", "credential", "credentials", "hardcoded", "token", "key", "password"] },
  { url: `${OWASP}/Transport_Layer_Security_Cheat_Sheet.html`, title: "OWASP: Transport Layer Security Cheat Sheet", publisher: "owasp", topics: ["tls", "ssl", "certificate", "verification", "rejectunauthorized", "transport"] },
  { url: `${OWASP}/Nodejs_Security_Cheat_Sheet.html`, title: "OWASP: Node.js Security Cheat Sheet", publisher: "owasp", topics: ["nodejs", "node", "security", "eval", "child_process", "injection"] },
  { url: `${OWASP}/Input_Validation_Cheat_Sheet.html`, title: "OWASP: Input Validation Cheat Sheet", publisher: "owasp", topics: ["input", "validation", "sanitize", "injection"] },
];

export function publisherForHost(host: string): OfficialPublisher | null {
  const h = host.toLowerCase();
  return OFFICIAL_PUBLISHERS.find((p) => p.hosts.includes(h)) ?? null;
}

export function isOfficialHost(url: URL): boolean {
  return publisherForHost(url.hostname) !== null;
}

/** Future search providers plug in here; hits are candidates, never evidence. */
export interface DocumentationSearchPort {
  search(query: string, limit: number): Promise<Array<{ url: string; title: string | null }>>;
}

export function scoreEntry(entry: CuratedEntry, queryTerms: string[]): number {
  const topics = new Set(entry.topics);
  let hits = 0;
  for (const term of queryTerms) if (topics.has(term)) hits += 1;
  // Title words count too, at half weight.
  const title = entry.title.toLowerCase();
  for (const term of queryTerms) if (!topics.has(term) && title.includes(term)) hits += 0.5;
  return hits;
}

export interface OfficialDocsOptions {
  fetchImpl: FetchLike;
  entries?: CuratedEntry[];
  searchPorts?: DocumentationSearchPort[];
  /** Query the MDN search API (default true). */
  useMdnSearch?: boolean;
  limiter?: MinIntervalLimiter;
}

type Robots = { allow: string[]; disallow: string[] } | null;

function parseRobots(text: string): Robots {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim());
  let applies = false;
  let seenGroup = false;
  const out = { allow: [] as string[], disallow: [] as string[] };
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      if (seenGroup && !applies) seenGroup = false;
      applies = applies || value === "*";
      seenGroup = true;
    } else if (applies && key === "disallow" && value) out.disallow.push(value);
    else if (applies && key === "allow" && value) out.allow.push(value);
    else if (line === "") seenGroup = false;
  }
  return out;
}

export function robotsAllows(robots: Robots, path: string): boolean {
  if (!robots) return true;
  const longest = (rules: string[]) =>
    rules.filter((r) => path.startsWith(r)).reduce((m, r) => Math.max(m, r.length), -1);
  return longest(robots.allow) >= longest(robots.disallow);
}

export class OfficialDocsProvider implements SourceProvider {
  readonly name = "official-docs" as const;
  private readonly limiter: MinIntervalLimiter;
  private readonly robotsCache = new Map<string, Robots>();

  constructor(private readonly options: OfficialDocsOptions) {
    this.limiter = options.limiter ?? new MinIntervalLimiter(300);
  }

  private async robots(host: string, ctx: DiscoveryContext): Promise<Robots> {
    if (this.robotsCache.has(host)) return this.robotsCache.get(host) ?? null;
    let robots: Robots = null;
    try {
      await ctx.countRequest();
      const body = await fetchBounded(`https://${host}/robots.txt`, {
        fetchImpl: this.options.fetchImpl,
        timeoutMs: ctx.limits.providerTimeoutMs,
        maxBytes: 200_000,
        accept: "text/plain",
        hostAllowed: isOfficialHost,
      });
      robots = parseRobots(body.text);
    } catch {
      robots = null; // no readable robots.txt: no restriction declared
    }
    this.robotsCache.set(host, robots);
    return robots;
  }

  private async candidates(query: QueryPlan, ctx: DiscoveryContext) {
    const terms = keywords(query.text);
    const out: Array<{ url: string; title: string | null; publisher: string | null }> = [];

    const entries = (this.options.entries ?? CURATED_ENTRIES)
      .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
      .filter((x) => x.score >= 1)
      .sort((a, b) => b.score - a.score || a.entry.url.localeCompare(b.entry.url))
      .slice(0, ctx.limits.maxSourcesPerQuery);
    for (const { entry } of entries) out.push({ url: entry.url, title: entry.title, publisher: entry.publisher });

    if (this.options.useMdnSearch !== false) {
      try {
        await ctx.countRequest();
        await this.limiter.acquire();
        const params = new URLSearchParams({ q: query.text, locale: "en-US", size: "3" });
        const body = await fetchBounded(`https://developer.mozilla.org/api/v1/search?${params}`, {
          fetchImpl: this.options.fetchImpl,
          timeoutMs: ctx.limits.providerTimeoutMs,
          maxBytes: 500_000,
          accept: "application/json",
          hostAllowed: (u) => u.hostname === "developer.mozilla.org",
        });
        const json = JSON.parse(body.text) as { documents?: Array<{ mdn_url?: unknown; title?: unknown }> };
        for (const doc of json.documents ?? []) {
          if (typeof doc.mdn_url === "string" && doc.mdn_url.startsWith("/")) {
            out.push({
              url: `https://developer.mozilla.org${doc.mdn_url}`,
              title: typeof doc.title === "string" ? doc.title : null,
              publisher: "mdn",
            });
          }
        }
      } catch {
        /* MDN search is optional; curated entries still apply */
      }
    }

    for (const port of this.options.searchPorts ?? []) {
      try {
        for (const hit of await port.search(query.text, ctx.limits.maxSourcesPerQuery)) {
          out.push({ url: hit.url, title: hit.title, publisher: null });
        }
      } catch {
        /* optional */
      }
    }

    // De-duplicate by canonical URL and keep only allow-listed official hosts.
    const seen = new Set<string>();
    return out
      .map((c) => ({ ...c, canonical: canonicalUrl(c.url) }))
      .filter((c): c is typeof c & { canonical: string } => {
        if (!c.canonical) return false;
        const host = new URL(c.canonical).hostname;
        if (!publisherForHost(host) || seen.has(c.canonical)) return false;
        seen.add(c.canonical);
        return true;
      })
      .slice(0, ctx.limits.maxSourcesPerQuery);
  }

  private unavailable(
    candidate: { canonical: string; title: string | null },
    ctx: DiscoveryContext,
  ): DiscoveredSource {
    const publisher = publisherForHost(new URL(candidate.canonical).hostname)!;
    const record: SourceRecord = {
      sourceKey: sourceKey({ doi: null, canonicalUrl: candidate.canonical }),
      kind: "OFFICIAL_DOCUMENTATION",
      sourceClass: "OFFICIAL",
      classificationBasis: `Host ${new URL(candidate.canonical).hostname} is an allow-listed official host of ${publisher.name}`,
      title: candidate.title ?? candidate.canonical,
      publisher: publisher.name,
      authors: [],
      container: null,
      canonicalUrl: candidate.canonical,
      doi: null,
      externalIds: {},
      publishedAt: null,
      updatedAt: null,
      contentLevel: "METADATA_ONLY",
      availability: "UNAVAILABLE",
      doiFromProvider: false,
      provider: "official-docs",
      retrievedAt: ctx.now().toISOString(),
      excerpt: "",
      contentHash: null,
      openAccess: null,
      license: null,
      citedByCount: null,
    };
    return { record, sections: [], reused: false };
  }

  private async load(
    candidate: { canonical: string; title: string | null },
    ctx: DiscoveryContext,
  ): Promise<DiscoveredSource> {
    const cached = await ctx.findCached(candidate.canonical);
    if (cached && cached.availability === "AVAILABLE") {
      return {
        record: cached,
        sections: cached.excerpt ? [{ heading: cached.title, text: cached.excerpt }] : [],
        reused: true,
      };
    }

    const url = new URL(candidate.canonical);
    const robots = await this.robots(url.hostname, ctx);
    if (!robotsAllows(robots, url.pathname)) return this.unavailable(candidate, ctx);

    try {
      await ctx.countRequest();
      await this.limiter.acquire();
      const page = await fetchBounded(candidate.canonical, {
        fetchImpl: this.options.fetchImpl,
        timeoutMs: ctx.limits.providerTimeoutMs,
        maxBytes: 1_500_000,
        accept: "text/html",
        hostAllowed: isOfficialHost,
      });
      if (!page.contentType.includes("html")) throw new ResearchHttpError("Not HTML.", "BAD_CONTENT");

      const parsed = parseHtmlPage(page.text);
      const finalCanonical = canonicalUrl(page.finalUrl) ?? candidate.canonical;
      const declared = parsed.canonicalHref ? canonicalUrl(new URL(parsed.canonicalHref, page.finalUrl).toString()) : null;
      // Trust the page's declared canonical URL only if it stays on an official host.
      const canonical =
        declared && publisherForHost(new URL(declared).hostname) ? declared : finalCanonical;
      const publisher = publisherForHost(new URL(canonical).hostname)!;
      const excerptSource = [parsed.description, parsed.text].filter(Boolean).join("\n");
      const excerpt = excerptSource.slice(0, EXCERPT_CACHE_CHARS);
      const record: SourceRecord = {
        sourceKey: sourceKey({ doi: null, canonicalUrl: canonical }),
        kind: "OFFICIAL_DOCUMENTATION",
        sourceClass: "OFFICIAL",
        classificationBasis: `Fetched from ${new URL(canonical).hostname}, an allow-listed official host of ${publisher.name}${page.redirected ? " (redirect followed within allowed hosts)" : ""}`,
        title: parsed.title ?? candidate.title ?? canonical,
        publisher: publisher.name,
        authors: [],
        container: null,
        canonicalUrl: canonical,
        doi: null,
        externalIds: {},
        publishedAt: parsed.publishedAt,
        updatedAt: parsed.updatedAt,
        contentLevel: excerpt ? "FULL_TEXT" : "METADATA_ONLY",
        availability: "AVAILABLE",
        doiFromProvider: false,
        provider: "official-docs",
        retrievedAt: ctx.now().toISOString(),
        excerpt,
        contentHash: parsed.text ? contentHash(parsed.text) : null,
        openAccess: null,
        license: null,
        citedByCount: null,
      };
      return { record, sections: parsed.sections, reused: false };
    } catch {
      return this.unavailable(candidate, ctx);
    }
  }

  async discover(query: QueryPlan, ctx: DiscoveryContext): Promise<ProviderResult> {
    const started = Date.now();
    try {
      const candidates = await this.candidates(query, ctx);
      if (candidates.length === 0) {
        return { sources: [], diagnostic: emptyDiagnostic(this.name, query, "EMPTY", "No official documentation matched this query.") };
      }
      const sources: DiscoveredSource[] = [];
      for (const candidate of candidates) sources.push(await this.load(candidate, ctx));
      const unavailable = sources.filter((s) => s.record.availability === "UNAVAILABLE").length;
      return {
        sources,
        diagnostic: {
          provider: this.name,
          queryOrdinal: query.ordinal,
          status: sources.length > unavailable ? "OK" : "UNAVAILABLE",
          returned: sources.length,
          durationMs: Date.now() - started,
          note: unavailable ? `${unavailable} page(s) could not be retrieved and are marked unavailable.` : null,
        },
      };
    } catch {
      return {
        sources: [],
        diagnostic: { ...emptyDiagnostic(this.name, query, "UNAVAILABLE", "Official documentation discovery failed."), durationMs: Date.now() - started },
      };
    }
  }
}

export { extractPassages };
