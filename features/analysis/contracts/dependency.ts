export type DependencyResolutionStatus = "resolved" | "missing" | "unresolved";

export type DependencyKind =
  "relative" | "package" | "alias" | "builtin" | "unknown";

export interface DependencyReference {
  /** Repository-relative path of the file containing the import. */
  sourceFile: string;

  /** Original import specifier, for example "./utils" or "react". */
  specifier: string;

  /** Classification of the dependency. */
  kind: DependencyKind;
}

export interface DependencyResolution {
  status: DependencyResolutionStatus;

  /** Original dependency reference supplied to the resolver. */
  reference: DependencyReference;

  /** Repository-relative path when resolution succeeds. */
  resolvedPath?: string;

  /** Human-readable explanation of the result. */
  reason: string;

  /** Evidence used to reach the result. */
  evidence: string[];
}
