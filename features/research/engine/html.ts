// features/research/engine/html.ts
//
// Minimal, dependency-free HTML reading for public documentation pages:
// title, description, dates, readable text and passage extraction. The output is
// plain text; page markup is never rendered or executed anywhere.
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-",
  rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', hellip: "...",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d{1,6});/g, (_m, n: string) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, n: string) => {
      const code = parseInt(n, 16);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    })
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function meta(html: string, names: string[]): string | null {
  for (const name of names) {
    const pattern = new RegExp(
      `<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`,
      "i",
    );
    const tag = pattern.exec(html)?.[0];
    if (!tag) continue;
    const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
    if (content) return decodeEntities(content).trim();
  }
  return null;
}

function validDate(value: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time) || time < Date.parse("1990-01-01") || time > Date.now() + 86_400_000) {
    return null;
  }
  return new Date(time).toISOString().slice(0, 10);
}

export interface ParsedPage {
  title: string | null;
  description: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  canonicalHref: string | null;
  sections: Array<{ heading: string; text: string }>;
  text: string;
}

export function parseHtmlPage(html: string): ParsedPage {
  const title =
    meta(html, ["og:title"]) ??
    (() => {
      const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
      return t ? stripTags(t) : null;
    })();
  const description = meta(html, ["description", "og:description"]);
  const publishedAt = validDate(
    meta(html, ["article:published_time", "datePublished"]) ??
      /"datePublished"\s*:\s*"([^"]+)"/.exec(html)?.[1] ??
      null,
  );
  const updatedAt = validDate(
    meta(html, ["article:modified_time", "og:updated_time", "last-modified"]) ??
      /"dateModified"\s*:\s*"([^"]+)"/.exec(html)?.[1] ??
      /<time[^>]+datetime=["']([^"']+)["']/i.exec(html)?.[1] ??
      null,
  );
  const canonicalHref =
    /<link[^>]+rel=["']canonical["'][^>]*>/i
      .exec(html)?.[0]
      ?.match(/href=["']([^"']+)["']/i)?.[1] ?? null;

  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, " ");
  const main = /<(main|article)[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (main) body = main[2];

  // Split on headings to keep a locator for each passage.
  const sections: Array<{ heading: string; text: string }> = [];
  const parts = body.split(/<h[1-4][^>]*>/i);
  const intro = stripTags(parts[0] ?? "");
  if (intro) sections.push({ heading: title ?? "Introduction", text: intro });
  for (const part of parts.slice(1)) {
    const end = part.search(/<\/h[1-4]>/i);
    if (end < 0) continue;
    const heading = stripTags(part.slice(0, end));
    const text = stripTags(part.slice(end).replace(/<\/h[1-4]>/i, " "));
    if (heading && text) sections.push({ heading, text });
  }
  return {
    title,
    description,
    publishedAt,
    updatedAt,
    canonicalHref,
    sections,
    text: sections.map((s) => `${s.heading}. ${s.text}`).join("\n"),
  };
}

const WORD = /[a-z0-9][a-z0-9'_-]{2,}/g;
const STOP = new Set(
  "the and for are with that this from have has was were will can you your not but all any how what when where why which their them there these those into than then also its our out use used using may more most other some such only over under about".split(" "),
);

export function keywords(text: string): string[] {
  return [...new Set((text.toLowerCase().match(WORD) ?? []).filter((w) => !STOP.has(w)))];
}

export interface ExtractedPassage {
  text: string;
  locator: string;
  score: number;
}

/** Picks the sentences-groups that best overlap the query; deterministic. */
export function extractPassages(
  sections: Array<{ heading: string; text: string }>,
  query: string,
  maxPassages: number,
  maxChars: number,
): ExtractedPassage[] {
  const terms = keywords(query);
  if (terms.length === 0) return [];
  const candidates: ExtractedPassage[] = [];
  for (const section of sections) {
    const sentences = section.text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [];
    let window = "";
    const flush = () => {
      const text = window.trim();
      window = "";
      if (text.length < 40) return;
      const lower = text.toLowerCase();
      const hits = terms.filter((t) => lower.includes(t)).length;
      if (hits === 0) return;
      candidates.push({
        text: text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text,
        locator: `section: ${section.heading.slice(0, 80)}`,
        score: hits / terms.length,
      });
    };
    for (const sentence of sentences) {
      if (window.length + sentence.length > maxChars) flush();
      window += sentence;
    }
    flush();
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.locator.localeCompare(b.locator) || a.text.localeCompare(b.text))
    .slice(0, maxPassages);
}
