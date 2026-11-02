const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

function normalisePath(path: string): string {
  const segments: string[] = [];

  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;

    if (segment === "..") {
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments.join("/");
}

function getDirectory(path: string): string {
  const normalised = normalisePath(path);
  const lastSlash = normalised.lastIndexOf("/");

  return lastSlash === -1 ? "" : normalised.slice(0, lastSlash);
}

function joinPath(base: string, relative: string): string {
  return normalisePath(`${base}/${relative}`);
}

export function resolveRelativeImport(
  importerPath: string,
  importSource: string,
  knownFiles: ReadonlySet<string>,
): string | null {
  if (!importSource.startsWith(".")) {
    return null;
  }

  const basePath = joinPath(getDirectory(importerPath), importSource);

  const candidates = [
    basePath,
    ...EXTENSIONS.map((extension) => `${basePath}${extension}`),
    ...EXTENSIONS.map((extension) => `${basePath}/index${extension}`),
  ];

  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) {
      return candidate;
    }
  }

  return null;
}
