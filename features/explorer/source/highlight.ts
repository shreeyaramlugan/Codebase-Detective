// features/explorer/source/highlight.ts
//
// Small, dependency-free tokenizer for the source viewer. It returns plain
// token data; the UI renders tokens as React text nodes, so repository
// content is never interpreted as markup and never executed.
//
// Deliberate simplifications (it is a viewer aid, not a parser):
//  - regular-expression literals are not recognised;
//  - `${...}` inside template literals is highlighted as part of the string.

export type TokenKind =
  "plain" | "keyword" | "string" | "comment" | "number" | "literal";

export interface Token {
  text: string;
  kind: TokenKind;
}

export type SourceLanguage = "script" | "json" | "plain";

const SCRIPT_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
]);

export function languageForPath(path: string): SourceLanguage {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  if (SCRIPT_EXTENSIONS.has(ext)) return "script";
  if (ext === "json") return "json";
  return "plain";
}

/**
 * Same line terminators as the TypeScript scanner used by the analysis
 * engine (CRLF, LF, CR, U+2028, U+2029), so line N here is line N in every
 * symbol and dependency location.
 */
export function splitLines(content: string): string[] {
  return content.split(/\r\n|[\n\r\u2028\u2029]/);
}

const KEYWORDS = new Set(
  (
    "abstract as async await break case catch class const continue debugger declare default delete do else enum " +
    "export extends finally for from function get if implements import in infer instanceof interface is keyof let " +
    "module namespace new of override private protected public readonly return satisfies set static super switch " +
    "this throw try type typeof var void while with yield accessor"
  ).split(" "),
);

const LITERALS = new Set(["true", "false", "null", "undefined", "NaN"]);
const JSON_LITERALS = new Set(["true", "false", "null"]);

export interface LineState {
  inBlockComment: boolean;
  inTemplate: boolean;
}

export const INITIAL_STATE: LineState = {
  inBlockComment: false,
  inTemplate: false,
};

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function push(tokens: Token[], kind: TokenKind, text: string) {
  if (text.length === 0) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) last.text += text;
  else tokens.push({ text, kind });
}

export function tokenizeLine(
  line: string,
  state: LineState,
  language: SourceLanguage,
): { tokens: Token[]; state: LineState } {
  const tokens: Token[] = [];
  let { inBlockComment, inTemplate } = state;
  let i = 0;

  if (language === "plain") {
    return { tokens: [{ text: line, kind: "plain" }], state };
  }

  const literals = language === "json" ? JSON_LITERALS : LITERALS;
  const allowComments = language === "script";

  while (i < line.length) {
    if (inBlockComment) {
      const end = line.indexOf("*/", i);
      if (end === -1) {
        push(tokens, "comment", line.slice(i));
        i = line.length;
      } else {
        push(tokens, "comment", line.slice(i, end + 2));
        i = end + 2;
        inBlockComment = false;
      }
      continue;
    }

    if (inTemplate) {
      let j = i;
      let closed = false;
      while (j < line.length) {
        if (line[j] === "\\") j += 2;
        else if (line[j] === "`") {
          j += 1;
          closed = true;
          break;
        } else j += 1;
      }
      push(tokens, "string", line.slice(i, Math.min(j, line.length)));
      i = Math.min(j, line.length);
      if (closed) inTemplate = false;
      continue;
    }

    const ch = line[i];
    const next = line[i + 1];

    if (allowComments && ch === "/" && next === "/") {
      push(tokens, "comment", line.slice(i));
      i = line.length;
    } else if (allowComments && ch === "/" && next === "*") {
      inBlockComment = true;
      push(tokens, "comment", "/*");
      i += 2;
    } else if (ch === "`" && language === "script") {
      inTemplate = true;
      push(tokens, "string", "`");
      i += 1;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") j += 2;
        else if (line[j] === ch) {
          j += 1;
          break;
        } else j += 1;
      }
      const end = Math.min(j, line.length);
      push(tokens, "string", line.slice(i, end));
      i = end;
    } else if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(next ?? ""))) {
      let j = i + 1;
      while (j < line.length && /[0-9A-Za-z_.]/.test(line[j])) j += 1;
      push(tokens, "number", line.slice(i, j));
      i = j;
    } else if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < line.length && isIdentPart(line[j])) j += 1;
      const word = line.slice(i, j);
      const kind: TokenKind =
        language === "script" && KEYWORDS.has(word)
          ? "keyword"
          : literals.has(word)
            ? "literal"
            : "plain";
      push(tokens, kind, word);
      i = j;
    } else {
      push(tokens, "plain", ch);
      i += 1;
    }
  }

  return { tokens, state: { inBlockComment, inTemplate } };
}

/** Highest size (UTF-16 code units) that is still tokenized. */
export const MAX_HIGHLIGHT_LENGTH = 600_000;

export interface HighlightedSource {
  lines: Token[][];
  language: SourceLanguage;
  /** True when highlighting was skipped because the file is very large. */
  highlightSkipped: boolean;
}

export function highlightSource(
  content: string,
  path: string,
): HighlightedSource {
  const rawLines = splitLines(content);
  const language = languageForPath(path);
  const skip = language === "plain" || content.length > MAX_HIGHLIGHT_LENGTH;

  if (skip) {
    return {
      lines: rawLines.map((line) => [{ text: line, kind: "plain" as const }]),
      language,
      highlightSkipped: language !== "plain",
    };
  }

  let state = INITIAL_STATE;
  const lines = rawLines.map((line) => {
    const result = tokenizeLine(line, state, language);
    state = result.state;
    return result.tokens;
  });

  return { lines, language, highlightSkipped: false };
}
