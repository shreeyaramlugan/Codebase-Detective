// features/code-intelligence/registry/symbol-identity.ts
//
// Identity rules for symbols.
//
// A symbol's key is a hash of: file path + parent key + kind + name + the
// ordinal among same-named siblings of the same kind under the same parent.
// It deliberately excludes line numbers, so moving code within a file keeps
// its identity, and excludes the analysis id, so identical inputs always give
// identical keys (determinism). Two same-named declarations in different
// files or scopes always hash differently because path/parent differ; two in
// the same scope are separated by the ordinal.
import { createHash } from "node:crypto";

import type { SymbolKind } from "../contracts";

export function createSymbolKey(input: {
  filePath: string;
  parentKey: string | null;
  kind: SymbolKind;
  name: string;
  ordinal: number;
}): string {
  const material = [
    input.filePath,
    input.parentKey ?? "",
    input.kind,
    input.name,
    String(input.ordinal),
  ].join("\u0000");

  return `sym_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

/**
 * Row id for a symbol inside one analysis run. Because the analysis id is part
 * of the hash, rows from different runs can never collide or be mixed even
 * though they share the run-independent key.
 */
export function createSymbolRowId(analysisId: string, key: string): string {
  return `sy_${createHash("sha256")
    .update(`${analysisId}\u0000${key}`)
    .digest("hex")
    .slice(0, 32)}`;
}

export function isSymbolKey(value: string): boolean {
  return /^sym_[0-9a-f]{32}$/.test(value);
}
