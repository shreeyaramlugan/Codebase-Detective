// lib/ai/ai.retrieval.ts
//
// Database-backed evidence retrieval. It is keyword-driven and deterministic:
// files and symbols that match the question are ranked first, then the
// dependency, call and finding records around them are pulled in. The result is
// a list of candidates; context.ts decides what fits in the budget.
//
// Boundaries enforced here:
//  * only the scope's analysis/snapshot is queried (the reader is scoped);
//  * sensitive files (.env, keys, ...) are never read;
//  * unavailable/corrupt files produce no evidence, never invented content;
//  * confirmed, possible, ambiguous and unresolved stay distinct certainties.
import type {
  EvidenceCandidate,
  EvidenceCertainty,
  SnapshotScope,
} from "@/features/ai/assistant/contracts";
import type { QuestionCategory } from "@/features/ai/assistant/question";
import { isSensitivePath } from "@/features/ai/assistant/redact";

import type {
  CallRow,
  DependencyRow,
  EvidenceReader,
  FindingRow,
  SymbolRow,
} from "./ai.reader";

const MAX_SOURCE_FILES = 6;
const SOURCE_LINES = 60;
const DOC_LINES = 80;
const FILE_LIMIT = 8;
const SYMBOL_LIMIT = 12;
const DEPENDENCY_LIMIT = 25;
const CALL_LIMIT = 15;
const FINDING_LIMIT = 12;

const BOOST: Record<QuestionCategory, Partial<Record<string, number>>> = {
  overview: { repository: 60, document: 45 },
  finding: { finding: 40 },
  impact: { dependency: 30, call: 30 },
  dependency: { dependency: 30 },
  flow: { call: 20, source: 10, dependency: 10 },
  symbol: { symbol: 10, source: 10 },
  file: { source: 10 },
  general: {},
};

function certaintyOfDependency(row: DependencyRow): EvidenceCertainty {
  if (row.status === "AMBIGUOUS") return "AMBIGUOUS";
  if (row.status === "UNRESOLVED") return "UNRESOLVED";
  return "CONFIRMED"; // RESOLVED or EXTERNAL: both established statically
}

function certaintyOfCall(row: CallRow): EvidenceCertainty {
  if (row.resolution === "CONFIRMED") return "CONFIRMED";
  if (row.resolution === "POSSIBLE") return "POSSIBLE";
  return "UNRESOLVED";
}

function certaintyOfFinding(row: FindingRow): EvidenceCertainty {
  return row.certainty === "INDICATOR" ? "INDICATOR" : "CONFIRMED";
}

function matchScore(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of terms) if (lower.includes(term)) score += 5;
  return score;
}

function dependencyText(row: DependencyRow, direction: "imports" | "importer") {
  const names = row.names.length ? ` (${row.names.slice(0, 8).join(", ")})` : "";
  const target =
    row.status === "RESOLVED"
      ? `resolved to ${row.targetPath}`
      : row.status === "EXTERNAL"
        ? `external package ${row.externalPackage ?? row.specifier}`
        : `${row.status.toLowerCase()}: ${row.reason}`;
  const verb = direction === "imports" ? "imports" : "is imported by";
  const subject = direction === "imports" ? row.path : (row.targetPath ?? "");
  const other = direction === "imports" ? `"${row.specifier}"` : row.path;
  return `${subject} ${verb} ${other}${names}${row.isTypeOnly ? " [type-only]" : ""}; ${target} [${row.status}]`;
}

function symbolText(row: SymbolRow): string {
  const flags = [
    row.isExported ? (row.isDefaultExport ? "default export" : "exported") : "not exported",
  ];
  const parent = row.parentName ? `; member of ${row.parentName}` : "";
  return `${row.kind.toLowerCase()} ${row.qualifiedName} in ${row.path} lines ${row.startLine}-${row.endLine}; ${flags.join(", ")}${parent}`;
}

function callText(row: CallRow): string {
  const caller = row.callerName ?? "(module level)";
  const target =
    row.resolution === "CONFIRMED" && row.targetName
      ? `-> ${row.targetName}${row.targetPath ? ` in ${row.targetPath}` : ""}`
      : `-> target not established (${row.reason})`;
  return `${caller} calls ${row.calleeText} ${target} [${row.resolution}]`;
}

function findingText(row: FindingRow): string {
  const evidence = row.evidence
    .slice(0, 3)
    .map(
      (e) =>
        `- ${e.message}${e.startLine !== null ? ` (${e.filePath}:${e.startLine})` : ""}`,
    )
    .join("\n");
  const measurements =
    row.measurements && typeof row.measurements === "object"
      ? `\nMeasurements: ${JSON.stringify(row.measurements).slice(0, 300)}`
      : "";
  return `Rule ${row.ruleId}; severity ${row.severity}; certainty ${row.certainty}\n${row.title}\n${row.description}${measurements}${evidence ? `\nEvidence:\n${evidence}` : ""}`;
}

export interface RetrieveInput {
  scope: SnapshotScope;
  terms: string[];
  category: QuestionCategory;
}

export async function retrieveEvidence(
  reader: EvidenceReader,
  input: RetrieveInput,
): Promise<EvidenceCandidate[]> {
  const { scope, terms, category } = input;
  const boost = BOOST[category];
  const out: EvidenceCandidate[] = [];

  // --- repository overview ------------------------------------------------
  const overview = await reader.overview(scope);
  out.push({
    kind: "repository",
    certainty: "NOT_APPLICABLE",
    path: null,
    startLine: null,
    endLine: null,
    symbolKey: null,
    title: "Repository and snapshot overview",
    text: [
      `Repository ${scope.repositoryName}, commit ${scope.commitSha}, snapshot completeness ${scope.completeness ?? "UNKNOWN"}.`,
      `${overview.files} files in the snapshot, ${overview.analysedFiles} analysed; ${overview.symbols} symbols; ${overview.dependencies} module dependencies (${overview.unresolvedDependencies} unresolved).`,
      overview.topLevel.length
        ? `Top-level entries: ${overview.topLevel.slice(0, 30).join(", ")}.`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    score: 1 + (boost.repository ?? 0),
  });

  // --- files and symbols matching the question ------------------------------
  const [files, symbols] = terms.length
    ? await Promise.all([
        reader.findFiles(scope, terms, FILE_LIMIT),
        reader.findSymbols(scope, terms, SYMBOL_LIMIT),
      ])
    : [[], []];

  const rankedFiles = files
    .map((f) => ({
      ...f,
      score:
        10 +
        matchScore(f.path, terms) +
        (terms.includes((f.path.split("/").pop() ?? "").toLowerCase()) ? 10 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const rankedSymbols = symbols
    .map((s) => ({
      ...s,
      score:
        20 +
        matchScore(`${s.name} ${s.qualifiedName}`, terms) +
        (terms.includes(s.name.toLowerCase()) ? 20 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.qualifiedName.localeCompare(b.qualifiedName));

  for (const symbol of rankedSymbols) {
    out.push({
      kind: "symbol",
      certainty: "CONFIRMED",
      path: symbol.path,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      symbolKey: symbol.stableKey,
      title: `Symbol ${symbol.qualifiedName}`,
      text: symbolText(symbol),
      score: symbol.score + (boost.symbol ?? 0),
    });
  }

  // --- source excerpts ------------------------------------------------------
  const sourceCache = new Map<string, string[] | null>();
  const loadLines = async (path: string): Promise<string[] | null> => {
    if (sourceCache.has(path)) return sourceCache.get(path) ?? null;
    if (isSensitivePath(path) || sourceCache.size >= MAX_SOURCE_FILES) {
      sourceCache.set(path, null);
      return null;
    }
    const text = await reader.readSource(scope, path);
    const lines = text === null ? null : text.replace(/\r\n/g, "\n").split("\n");
    sourceCache.set(path, lines);
    return lines;
  };

  for (const symbol of rankedSymbols.slice(0, 4)) {
    const lines = await loadLines(symbol.path);
    if (!lines) continue;
    const start = Math.max(1, symbol.startLine);
    const end = Math.min(lines.length, symbol.endLine, start + SOURCE_LINES - 1);
    if (end < start) continue;
    out.push({
      kind: "source",
      certainty: "CONFIRMED",
      path: symbol.path,
      startLine: start,
      endLine: end,
      symbolKey: symbol.stableKey,
      title: `Source of ${symbol.qualifiedName}`,
      text: lines.slice(start - 1, end).join("\n"),
      score: symbol.score + 5 + (boost.source ?? 0),
    });
  }

  for (const file of rankedFiles.slice(0, 3)) {
    const lines = await loadLines(file.path);
    if (!lines) continue;
    const end = Math.min(lines.length, SOURCE_LINES);
    if (end < 1) continue;
    out.push({
      kind: "source",
      certainty: "CONFIRMED",
      path: file.path,
      startLine: 1,
      endLine: end,
      symbolKey: null,
      title: `Start of ${file.path}`,
      text: lines.slice(0, end).join("\n"),
      score: file.score + (boost.source ?? 0),
    });
  }

  // --- dependencies and calls around the best matches ------------------------
  const focusPaths = [
    ...new Set([
      ...rankedFiles.slice(0, 3).map((f) => f.path),
      ...rankedSymbols.slice(0, 3).map((s) => s.path),
    ]),
  ].slice(0, 4);

  for (const path of focusPaths) {
    const { imports, importers } = await reader.fileDependencies(
      scope,
      path,
      DEPENDENCY_LIMIT,
    );
    const push = (row: DependencyRow, direction: "imports" | "importer") =>
      out.push({
        kind: "dependency",
        certainty: certaintyOfDependency(row),
        path: row.path,
        startLine: row.startLine,
        endLine: row.endLine,
        symbolKey: null,
        title: `Dependency: ${row.path} -> ${row.specifier}`,
        text: dependencyText(row, direction),
        score: 8 + (boost.dependency ?? 0) + matchScore(row.specifier, terms),
      });
    imports.forEach((row) => push(row, "imports"));
    importers.forEach((row) => push(row, "importer"));
  }

  for (const symbol of rankedSymbols.slice(0, 3)) {
    const calls = await reader.symbolCalls(scope, symbol.id, CALL_LIMIT);
    for (const row of calls) {
      out.push({
        kind: "call",
        certainty: certaintyOfCall(row),
        path: row.path,
        startLine: row.startLine,
        endLine: row.endLine,
        symbolKey: null,
        title: `Call: ${row.callerName ?? "module"} -> ${row.calleeText}`,
        text: callText(row),
        score: 8 + (boost.call ?? 0) + matchScore(row.calleeText, terms),
      });
    }
  }

  // --- deterministic findings ---------------------------------------------
  if (scope.findingsRunId) {
    const findings = await reader.findFindings(scope, {
      terms,
      paths: focusPaths,
      top: category === "finding",
      limit: FINDING_LIMIT,
    });
    for (const row of findings) {
      out.push({
        kind: "finding",
        certainty: certaintyOfFinding(row),
        path: row.subjectPath,
        startLine: row.primaryLine,
        endLine: row.primaryLine,
        symbolKey: null,
        title: `Finding ${row.ruleId}: ${row.title}`,
        text: findingText(row),
        score:
          12 +
          (boost.finding ?? 0) +
          matchScore(`${row.title} ${row.ruleId} ${row.subjectPath}`, terms),
      });
    }
  }

  // --- documentation (README and docs) --------------------------------------
  const docPaths = await reader.listDocumentPaths(scope, 5);
  for (const path of docPaths) {
    const lines = await loadLines(path);
    if (!lines) continue;
    const end = Math.min(lines.length, DOC_LINES);
    if (end < 1) continue;
    out.push({
      kind: "document",
      certainty: "NOT_APPLICABLE",
      path,
      startLine: 1,
      endLine: end,
      symbolKey: null,
      title: `Documentation ${path}`,
      text: lines.slice(0, end).join("\n"),
      score: 4 + (boost.document ?? 0) + matchScore(path, terms),
    });
  }

  return out;
}
