// tests/unit/research-engine/identity-providers.test.ts
import { describe, expect, it } from "vitest";

import { DEFAULT_RESEARCH_LIMITS, resolveResearchLimits, resolveRuntimeOptions } from "../../../features/research/engine/config";
import { canonicalUrl, normaliseDoi, sourceKey } from "../../../features/research/engine/identity";
import { extractPassages, parseHtmlPage } from "../../../features/research/engine/html";
import { fetchBounded, isPublicHostname } from "../../../features/research/engine/http";
import { CrossrefProvider, classifyCrossref, parseCrossrefItem } from "../../../features/research/engine/providers/crossref";
import { OpenAlexProvider, classifyOpenAlex, parseOpenAlexWork, rebuildAbstract } from "../../../features/research/engine/providers/openalex";
import { OfficialDocsProvider, isOfficialHost } from "../../../features/research/engine/providers/official-docs";
import { MinIntervalLimiter } from "../../../features/research/engine/rate-limit";
import type { DiscoveryContext } from "../../../features/research/engine/providers/types";
import type { QueryPlan } from "../../../features/research/engine/contracts";

const plan: QueryPlan = { ordinal: 1, text: "circular dependencies modules", rationale: "r", targets: ["CROSSREF"] };
const NOW = new Date("2026-11-09T12:00:00.000Z");

function ctx(over: Partial<DiscoveryContext> = {}): DiscoveryContext & { requests: number } {
  const c = {
    requests: 0,
    limits: DEFAULT_RESEARCH_LIMITS,
    now: () => NOW,
    countRequest: async () => { c.requests += 1; },
    findCached: async () => null,
    ...over,
  };
  return c as DiscoveryContext & { requests: number };
}

const instant = () => new MinIntervalLimiter(0, () => 0, async () => undefined);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("source identity", () => {
  it("canonicalises URLs and strips tracking parameters", () => {
    expect(canonicalUrl("http://Example.com/a/?utm_source=x&b=2&a=1#frag")).toBe("https://example.com/a/?a=1&b=2");
    expect(canonicalUrl("ftp://example.com/x")).toBeNull();
    expect(canonicalUrl("https://user:pw@example.com/")).toBeNull();
  });

  it("normalises DOIs and rejects non-DOIs", () => {
    expect(normaliseDoi("https://doi.org/10.1000/ABC.1")).toBe("10.1000/abc.1");
    expect(normaliseDoi("doi: 10.1000/xyz.")).toBe("10.1000/xyz");
    expect(normaliseDoi("not a doi")).toBeNull();
  });

  it("prefers the DOI so the same paper from two providers merges", () => {
    const a = sourceKey({ doi: "10.1/x", canonicalUrl: "https://a.example/1" });
    const b = sourceKey({ doi: "10.1/x", canonicalUrl: "https://b.example/2" });
    expect(a).toBe(b);
    expect(sourceKey({ doi: null, canonicalUrl: "https://a.example/1" })).not.toBe(a);
  });
});

describe("limits and options", () => {
  it("clamps limits and never reads the user's email", () => {
    const l = resolveResearchLimits({ RESEARCH_DAILY_RUN_LIMIT: "999999" });
    expect(l.dailyRunLimit).toBeLessThan(999_999);
    expect(resolveRuntimeOptions({}).contactEmail).toBeNull();
    expect(resolveRuntimeOptions({ RESEARCH_CONTACT_EMAIL: "ops@example.com" }).contactEmail).toBe("ops@example.com");
    expect(resolveRuntimeOptions({ RESEARCH_CONTACT_EMAIL: "bad" }).contactEmail).toBeNull();
    expect(resolveRuntimeOptions({}).openAlexApiKey).toBeNull();
    expect(resolveRuntimeOptions({ OPENALEX_API_KEY: " abcDEF1234567890 " }).openAlexApiKey).toBe("abcDEF1234567890");
    expect(resolveRuntimeOptions({ OPENALEX_API_KEY: "bad key!" }).openAlexApiKey).toBeNull();
  });
});

describe("html parsing", () => {
  it("drops scripts and styles and extracts query-relevant passages", () => {
    const page = parseHtmlPage(
      "<html><head><title>Cycles</title></head><body><script>alert(1)</script><h2>Circular imports</h2><p>Circular imports leave bindings uninitialised until both modules finish.</p><h2>Other</h2><p>Unrelated text about colours.</p></body></html>",
    );
    const flat = JSON.stringify(page);
    expect(flat).not.toContain("alert(1)");
    const passages = extractPassages(page.sections, "circular imports bindings", 2, 200);
    expect(passages.length).toBeGreaterThan(0);
    expect(passages[0].text.toLowerCase()).toContain("circular");
  });
});

describe("fetchBounded", () => {
  it("refuses hosts the caller does not allow, including via redirect", async () => {
    const fetchImpl = (async (url: string) =>
      url.includes("start")
        ? new Response("", { status: 302, headers: { location: "https://evil.example/x" } })
        : new Response("hi")) as unknown as typeof fetch;
    await expect(
      fetchBounded("https://good.example/start", {
        fetchImpl,
        timeoutMs: 1000,
        maxBytes: 1000,
        accept: "text/html",
        hostAllowed: (u) => u.hostname === "good.example",
      }),
    ).rejects.toThrow();
  });

  it("rejects bodies over the byte limit", async () => {
    const fetchImpl = (async () => new Response("x".repeat(5000))) as unknown as typeof fetch;
    await expect(
      fetchBounded("https://good.example/", { fetchImpl, timeoutMs: 1000, maxBytes: 100, accept: "*/*", hostAllowed: () => true }),
    ).rejects.toThrow();
  });

  it("treats IP literals and local names as non-public", () => {
    expect(isPublicHostname("localhost")).toBe(false);
    expect(isPublicHostname("127.0.0.1")).toBe(false);
    expect(isPublicHostname("developer.mozilla.org")).toBe(true);
  });
});

describe("Crossref", () => {
  const item = {
    DOI: "10.1000/Cycle.1",
    title: ["Cyclic dependencies in practice"],
    author: [{ given: "Ada", family: "Lovelace" }],
    issued: { "date-parts": [[2020, 5, 1]] },
    type: "journal-article",
    "container-title": ["Journal of Software"],
    abstract: "<jats:p>Abstract We study cycles between modules.</jats:p>",
    publisher: "Acme Press",
    URL: "https://doi.org/10.1000/cycle.1",
  };

  it("builds a record from provider fields only and labels abstract-only content", () => {
    const parsed = parseCrossrefItem(item, NOW.toISOString())!;
    expect(parsed.record.doi).toBe("10.1000/cycle.1");
    expect(parsed.record.doiFromProvider).toBe(true);
    expect(parsed.record.contentLevel).toBe("ABSTRACT");
    expect(parsed.record.sourceClass).toBe("PEER_REVIEWED");
    expect(parsed.record.classificationBasis).toMatch(/not verified/);
    expect(parsed.record.excerpt).not.toMatch(/</);
  });

  it("marks items without an abstract as metadata only and skips items without DOI or title", () => {
    const { abstract: _a, ...noAbstract } = item;
    void _a;
    expect(parseCrossrefItem(noAbstract, NOW.toISOString())!.record.contentLevel).toBe("METADATA_ONLY");
    expect(parseCrossrefItem({ ...item, DOI: undefined }, NOW.toISOString())).toBeNull();
    expect(parseCrossrefItem({ ...item, title: [] }, NOW.toISOString())).toBeNull();
  });

  it("classifies preprints and other scholarly material", () => {
    expect(classifyCrossref("posted-content", null).sourceClass).toBe("PREPRINT");
    expect(classifyCrossref("book-chapter", null).sourceClass).toBe("OTHER_SCHOLARLY");
  });

  it("sends mailto only when a contact is configured and never the signed-in user's email", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => { urls.push(url); return json({ message: { items: [item] } }); }) as unknown as typeof fetch;
    const c = ctx();
    const withoutContact = await new CrossrefProvider({ fetchImpl, contactEmail: null, limiter: instant() }).discover(plan, c);
    expect(withoutContact.sources).toHaveLength(1);
    expect(urls[0]).not.toContain("mailto");
    await new CrossrefProvider({ fetchImpl, contactEmail: "ops@example.com", limiter: instant() }).discover(plan, c);
    expect(urls[1]).toContain("mailto=ops%40example.com");
    expect(urls.join(" ")).not.toContain("elevateavenue");
    expect(c.requests).toBe(2);
  });

  it("reports rate limiting and failures as diagnostics instead of throwing", async () => {
    const limited = (async () => new Response("", { status: 429 })) as unknown as typeof fetch;
    const r = await new CrossrefProvider({ fetchImpl: limited, contactEmail: null, limiter: instant() }).discover(plan, ctx());
    expect(r.sources).toHaveLength(0);
    expect(r.diagnostic.status).toBe("RATE_LIMITED");
    const broken = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    const b = await new CrossrefProvider({ fetchImpl: broken, contactEmail: null, limiter: instant() }).discover(plan, ctx());
    expect(b.diagnostic.status).toBe("UNAVAILABLE");
    expect(JSON.stringify(b.diagnostic)).not.toContain("boom");
  });
});

describe("OpenAlex", () => {
  const work = {
    id: "https://openalex.org/W1",
    doi: "https://doi.org/10.5555/abc",
    title: "Reducing coupling",
    publication_date: "2019-03-02",
    type: "article",
    primary_location: { landing_page_url: "https://journal.example/p1", source: { type: "journal", display_name: "J. Soft" } },
    abstract_inverted_index: { Coupling: [0], hurts: [1], maintainability: [2] },
    open_access: { is_oa: true },
    cited_by_count: 4,
  };

  it("rebuilds abstracts in order", () => {
    expect(rebuildAbstract({ b: [1], a: [0], c: [2] })).toBe("a b c");
    expect(rebuildAbstract(null)).toBe("");
  });

  it("parses a work and keeps provenance", () => {
    const p = parseOpenAlexWork(work, NOW.toISOString())!;
    expect(p.record.doi).toBe("10.5555/abc");
    expect(p.record.contentLevel).toBe("ABSTRACT");
    expect(p.record.excerpt).toBe("Coupling hurts maintainability");
    expect(p.record.externalIds.openalex).toBe("https://openalex.org/W1");
    expect(classifyOpenAlex({ ...work, type: "preprint" }).sourceClass).toBe("PREPRINT");
  });

  it("queries only api.openalex.org and tolerates provider errors", async () => {
    const urls: string[] = [];
    const ok = (async (url: string) => { urls.push(url); return json({ results: [work] }); }) as unknown as typeof fetch;
    const r = await new OpenAlexProvider({ fetchImpl: ok, contactEmail: null, limiter: instant() }).discover(plan, ctx());
    expect(r.sources).toHaveLength(1);
    expect(new URL(urls[0]).hostname).toBe("api.openalex.org");
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const d = await new OpenAlexProvider({ fetchImpl: down, contactEmail: null, limiter: instant() }).discover(plan, ctx());
    expect(d.diagnostic.status).toBe("UNAVAILABLE");
    expect(d.diagnostic.note).toContain("HTTP 503");
  });

  it("sends the API key when configured and explains a missing key without leaking it", async () => {
    const urls: string[] = [];
    const ok = (async (url: string) => { urls.push(url); return json({ results: [work] }); }) as unknown as typeof fetch;
    await new OpenAlexProvider({ fetchImpl: ok, contactEmail: null, apiKey: "secretKey12345", limiter: instant() }).discover(plan, ctx());
    expect(urls[0]).toContain("api_key=secretKey12345");
    await new OpenAlexProvider({ fetchImpl: ok, contactEmail: null, limiter: instant() }).discover(plan, ctx());
    expect(urls[1]).not.toContain("api_key");

    const refused = (async () => new Response("", { status: 409 })) as unknown as typeof fetch;
    const r = await new OpenAlexProvider({ fetchImpl: refused, contactEmail: null, limiter: instant() }).discover(plan, ctx());
    expect(r.diagnostic.note).toContain("OPENALEX_API_KEY");
    const withKey = await new OpenAlexProvider({ fetchImpl: refused, contactEmail: null, apiKey: "secretKey12345", limiter: instant() }).discover(plan, ctx());
    expect(JSON.stringify(withKey.diagnostic)).not.toContain("secretKey12345");
  });
});

describe("official documentation", () => {
  it("only recognises allow-listed publisher hosts", () => {
    expect(isOfficialHost(new URL("https://developer.mozilla.org/en-US/docs/x"))).toBe(true);
    expect(isOfficialHost(new URL("https://evil-mozilla.org/x"))).toBe(false);
    expect(isOfficialHost(new URL("https://developer.mozilla.org.evil.example/x"))).toBe(false);
  });

  it("verifies pages by fetching them and records unreachable pages as unavailable", async () => {
    const page =
      "<html><head><title>Modules</title></head><body><h2>Circular dependencies</h2><p>Circular dependencies between modules can leave exports uninitialised.</p></body></html>";
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("robots.txt")) return new Response("User-agent: *\nAllow: /", { status: 200 });
      if (url.includes("nodejs.org")) return new Response("nope", { status: 500 });
      return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const provider = new OfficialDocsProvider({
      fetchImpl,
      useMdnSearch: false,
      limiter: instant(),
      entries: [
        { url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules", title: "JavaScript modules", publisher: "mdn", topics: ["circular", "dependencies", "modules"] },
        { url: "https://nodejs.org/api/modules.html", title: "Node.js modules", publisher: "nodejs", topics: ["circular", "dependencies", "modules"] },
      ],
    });
    const r = await provider.discover({ ...plan, targets: ["OFFICIAL_DOCUMENTATION"] }, ctx());
    const ok = r.sources.find((s) => s.record.canonicalUrl.includes("mozilla"));
    const bad = r.sources.find((s) => s.record.canonicalUrl.includes("nodejs"));
    expect(ok?.record.availability).toBe("AVAILABLE");
    expect(ok?.record.sourceClass).toBe("OFFICIAL");
    expect(ok?.sections.length).toBeGreaterThan(0);
    expect(bad?.record.availability).toBe("UNAVAILABLE");
    expect(bad?.sections).toHaveLength(0);
  });
});

describe("rate limiter", () => {
  it("spaces calls by the minimum interval", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const l = new MinIntervalLimiter(1000, () => t, async (ms) => { sleeps.push(ms); t += ms; });
    await l.acquire();
    await l.acquire();
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1000);
  });
});
