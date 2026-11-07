// features/code-intelligence/registry/symbol-registry.ts
//
// In-memory registry for one analysis run. Provides lookup by key, file and
// scope, and enforces the registry invariants before anything is persisted.
import type { SymbolRecord } from "../contracts";
import { isSymbolKey } from "./symbol-identity";

export class SymbolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SymbolRegistryError";
  }
}

export class SymbolRegistry {
  private readonly byKey = new Map<string, SymbolRecord>();
  private readonly byFile = new Map<string, SymbolRecord[]>();
  private readonly byParent = new Map<string, SymbolRecord[]>();

  constructor(symbols: readonly SymbolRecord[] = []) {
    for (const symbol of symbols) this.add(symbol);
  }

  add(symbol: SymbolRecord): void {
    if (!isSymbolKey(symbol.key)) {
      throw new SymbolRegistryError(`Invalid symbol key: ${symbol.key}`);
    }

    if (this.byKey.has(symbol.key)) {
      throw new SymbolRegistryError(`Duplicate symbol key: ${symbol.key}`);
    }

    this.byKey.set(symbol.key, symbol);
    push(this.byFile, symbol.filePath, symbol);
    push(this.byParent, symbol.parentKey ?? "", symbol);
  }

  get size(): number {
    return this.byKey.size;
  }

  getByKey(key: string): SymbolRecord | undefined {
    return this.byKey.get(key);
  }

  getByFile(filePath: string): readonly SymbolRecord[] {
    return this.byFile.get(filePath) ?? [];
  }

  /** Direct children of a symbol; pass null for file top-level symbols. */
  getChildren(
    parentKey: string | null,
    filePath?: string,
  ): readonly SymbolRecord[] {
    const children = this.byParent.get(parentKey ?? "") ?? [];
    return filePath === undefined
      ? children
      : children.filter((child) => child.filePath === filePath);
  }

  /** Symbols named `name` directly inside the given scope. */
  lookupInScope(
    name: string,
    scopeKey: string | null,
    filePath: string,
  ): readonly SymbolRecord[] {
    return this.getChildren(scopeKey, filePath).filter(
      (symbol) => symbol.name === name,
    );
  }

  all(): readonly SymbolRecord[] {
    return [...this.byKey.values()];
  }

  /**
   * Verifies registry invariants: valid keys, parents exist, parents are in the
   * same file, and every symbol's file is a known analysed file.
   */
  validate(knownFilePaths: ReadonlySet<string>): string[] {
    const problems: string[] = [];

    for (const symbol of this.byKey.values()) {
      if (!knownFilePaths.has(symbol.filePath)) {
        problems.push(
          `Symbol ${symbol.key} references unknown file ${symbol.filePath}`,
        );
      }

      if (symbol.parentKey !== null) {
        const parent = this.byKey.get(symbol.parentKey);

        if (!parent) {
          problems.push(
            `Symbol ${symbol.key} has missing parent ${symbol.parentKey}`,
          );
        } else if (parent.filePath !== symbol.filePath) {
          problems.push(
            `Symbol ${symbol.key} has a parent in a different file`,
          );
        }
      }
    }

    return problems;
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
