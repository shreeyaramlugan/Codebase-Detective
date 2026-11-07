// features/code-intelligence/resolution/path-utils.ts
//
// POSIX path helpers for repository-relative paths. Paths never touch the
// real filesystem; they are only strings compared against the snapshot index.

export interface NormalisedPath {
  path: string;
  /** True when ".." tried to climb above the repository root. */
  escapedRoot: boolean;
}

export function normalisePath(input: string): NormalisedPath {
  const segments: string[] = [];

  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;

    if (segment === "..") {
      if (segments.length === 0) return { path: "", escapedRoot: true };
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return { path: segments.join("/"), escapedRoot: false };
}

export function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

export function joinPath(base: string, relative: string): NormalisedPath {
  return normalisePath(base ? `${base}/${relative}` : relative);
}

export function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

/** Directory chain from the file's directory up to the root ("" last). */
export function ancestorDirectories(path: string): string[] {
  const directories: string[] = [];
  let current = dirname(path);

  while (true) {
    directories.push(current);
    if (current === "") break;
    current = dirname(current);
  }

  return directories;
}

/** "@scope/pkg/sub" -> "@scope/pkg", "pkg/sub" -> "pkg". */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  if (specifier.startsWith("@") && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}
