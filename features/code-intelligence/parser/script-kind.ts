// features/code-intelligence/parser/script-kind.ts
import ts from "typescript";

import type { ModuleSyntax, ScriptKindName } from "../contracts";

const EXTENSION_TO_SCRIPT_KIND: Record<string, ScriptKindName> = {
  ".js": "JS",
  ".mjs": "JS",
  ".cjs": "JS",
  ".jsx": "JSX",
  ".ts": "TS",
  ".tsx": "TSX",
};

export const SUPPORTED_SOURCE_EXTENSIONS: readonly string[] = Object.keys(
  EXTENSION_TO_SCRIPT_KIND,
);

export function getExtension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

export function isSupportedSourcePath(path: string): boolean {
  return getExtension(path) in EXTENSION_TO_SCRIPT_KIND;
}

/** Maps a path to the script kind used for parsing, or null if unsupported. */
export function getScriptKindName(path: string): ScriptKindName | null {
  return EXTENSION_TO_SCRIPT_KIND[getExtension(path)] ?? null;
}

export function toTsScriptKind(kind: ScriptKindName): ts.ScriptKind {
  switch (kind) {
    case "JS":
      return ts.ScriptKind.JS;
    case "JSX":
      return ts.ScriptKind.JSX;
    case "TS":
      return ts.ScriptKind.TS;
    case "TSX":
      return ts.ScriptKind.TSX;
  }
}

/**
 * `.mjs` is always ESM and `.cjs` always CommonJS. Other extensions depend on
 * the syntax found (decided by the extractor), so they start as UNKNOWN.
 */
export function getDeclaredModuleSyntax(path: string): ModuleSyntax {
  const extension = getExtension(path);
  if (extension === ".mjs") return "ESM";
  if (extension === ".cjs") return "COMMONJS";
  return "UNKNOWN";
}
