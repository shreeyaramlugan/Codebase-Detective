// features/ai/assistant/answer.ts
//
// Strict parser for the provider's JSON answer. Anything that does not match
// the schema is rejected as malformed; it is never displayed.
import type { SectionType } from "./contracts";

export class MalformedAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedAnswerError";
  }
}

export interface RawCitation {
  evidence: string;
  startLine?: number;
  endLine?: number;
}
export interface RawSection {
  type: SectionType;
  text: string;
  citations: RawCitation[];
}
export interface RawAnswer {
  answerable: boolean;
  sections: RawSection[];
  limitations: string[];
}

const MAX_SECTIONS = 20;
const MAX_TEXT = 1_500;
const MAX_CITATIONS = 8;
const MAX_LIMITATIONS = 5;
const MAX_LIMITATION = 300;
const TYPES: SectionType[] = ["fact", "inference", "uncertainty"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1] : trimmed;
}

export function parseModelAnswer(raw: string): RawAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    throw new MalformedAnswerError("The answer was not valid JSON.");
  }
  // Models occasionally wrap the object in a one-element array.
  if (Array.isArray(parsed) && parsed.length === 1) parsed = parsed[0];
  if (!isRecord(parsed)) throw new MalformedAnswerError("Unexpected shape.");

  // The flag is the only field models drop or stringify in practice. Accept
  // "true"/"false", and when it is absent infer it from whether any section
  // was produced. This does not weaken grounding: every citation is still
  // verified against the stored source before an answer is shown.
  let answerable: boolean;
  if (typeof parsed.answerable === "boolean") {
    answerable = parsed.answerable;
  } else if (parsed.answerable === "true" || parsed.answerable === "false") {
    answerable = parsed.answerable === "true";
  } else if (parsed.answerable === undefined && Array.isArray(parsed.sections)) {
    answerable = parsed.sections.length > 0;
  } else {
    // Names only (never values), so an operator can see what the model sent.
    const keys = Object.keys(parsed)
      .slice(0, 6)
      .map((key) => key.replace(/[^A-Za-z0-9_]/g, "").slice(0, 24))
      .join(",");
    throw new MalformedAnswerError(`Missing answerable flag (keys: ${keys || "none"}).`);
  }
  if (!Array.isArray(parsed.sections) || parsed.sections.length > MAX_SECTIONS) {
    throw new MalformedAnswerError("Invalid sections.");
  }

  const sections: RawSection[] = parsed.sections.map((entry) => {
    if (!isRecord(entry)) throw new MalformedAnswerError("Invalid section.");
    const { type, text, citations } = entry;
    if (typeof type !== "string" || !TYPES.includes(type as SectionType)) {
      throw new MalformedAnswerError("Invalid section type.");
    }
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) {
      throw new MalformedAnswerError("Invalid section text.");
    }
    const list = citations === undefined ? [] : citations;
    if (!Array.isArray(list) || list.length > MAX_CITATIONS) {
      throw new MalformedAnswerError("Invalid citations.");
    }
    return {
      type: type as SectionType,
      text: text.trim(),
      citations: list.map((citation): RawCitation => {
        if (!isRecord(citation) || typeof citation.evidence !== "string") {
          throw new MalformedAnswerError("Invalid citation.");
        }
        const out: RawCitation = { evidence: citation.evidence.trim() };
        if (citation.startLine !== undefined) {
          out.startLine = citation.startLine as number;
        }
        if (citation.endLine !== undefined) {
          out.endLine = citation.endLine as number;
        }
        return out;
      }),
    };
  });

  const limitations = Array.isArray(parsed.limitations)
    ? parsed.limitations
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, MAX_LIMITATION))
        .filter(Boolean)
        .slice(0, MAX_LIMITATIONS)
    : [];

  return { answerable, sections, limitations };
}
