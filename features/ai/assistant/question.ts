// features/ai/assistant/question.ts
//
// Question validation, classification and term extraction. Classification
// only steers which evidence is retrieved first; it never changes what the
// assistant is allowed to claim.
export type QuestionCategory =
  | "overview"
  | "finding"
  | "impact"
  | "dependency"
  | "flow"
  | "symbol"
  | "file"
  | "general";

export class QuestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionError";
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function validateQuestion(raw: unknown, maxChars: number): string {
  if (typeof raw !== "string") {
    throw new QuestionError("A question is required.");
  }
  const question = raw.replace(/\r\n/g, "\n").trim();
  if (question.length === 0) throw new QuestionError("A question is required.");
  if (question.length > maxChars) {
    throw new QuestionError(
      `The question is too long (maximum ${maxChars} characters).`,
    );
  }
  if (CONTROL.test(question)) {
    throw new QuestionError("The question contains unsupported characters.");
  }
  return question;
}

const RULES: Array<[QuestionCategory, RegExp]> = [
  ["finding", /\b(finding|findings|flagged|rule|severity|why was)\b/i],
  [
    "impact",
    /\b(impact|affect|affected|break|breaks|if i change|if we change|blast radius)\b/i,
  ],
  [
    "dependency",
    /\b(depend|depends|dependency|dependencies|import|imports|imported|export|exports|circular|require)\b/i,
  ],
  [
    "flow",
    /\b(how does|how do|flow|authenticat|authoriz|configured|where is|lifecycle)\b/i,
  ],
  [
    "overview",
    /\b(overview|purpose|structure|architecture|what is this|what does this repo|summar)/i,
  ],
  ["symbol", /\b(function|method|class|interface|type|enum|variable)\b/i],
  [
    "file",
    /\b(file|module|folder|directory)\b|\.(ts|tsx|js|jsx|mjs|cjs)\b|\//i,
  ],
];

export function classifyQuestion(question: string): QuestionCategory {
  for (const [category, pattern] of RULES) {
    if (pattern.test(question)) return category;
  }
  return "general";
}

const STOPWORDS = new Set(
  (
    "a an and are as at be by can could do does did for from has have how i if in is it its " +
    "me my of on or our should that the their them there these this to was we what when where " +
    "which who why will with would you your about into than then also any all each other repo " +
    "repository codebase code explain tell show find work works used use using"
  ).split(" "),
);

export const MAX_TERMS = 12;

/** Lower-cased, de-duplicated search terms; identifiers and paths are kept whole. */
export function extractTerms(question: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  const tokens = question.match(/[A-Za-z0-9_$@./-]{2,80}/g) ?? [];
  for (const token of tokens) {
    const cleaned = token.replace(/^[./-]+|[./-]+$/g, "");
    const lower = cleaned.toLowerCase();
    if (lower.length < 2 || STOPWORDS.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    terms.push(lower);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}
