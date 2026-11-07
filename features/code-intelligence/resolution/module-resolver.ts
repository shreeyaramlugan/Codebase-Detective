// features/code-intelligence/resolution/module-resolver.ts
//
// Resolves module specifiers to repository files using only evidence in the
// stored snapshot: file existence, tsconfig/jsconfig aliases and package.json
// metadata. It never touches the filesystem, never loads modules and never
// guesses. Outcomes are RESOLVED / UNRESOLVED / AMBIGUOUS / EXTERNAL, and the
// original specifier is always kept by the caller.
import { builtinModules } from "node:module";

import type { DependencyKind, ResolutionStatus } from "../contracts";
import {
  isRelativeSpecifier,
  joinPath,
  normalisePath,
  packageNameOf,
} from "./path-utils";
import {
  findNearestPackage,
  findNearestTsConfig,
  type PackageInfo,
  type PathAlias,
  type ProjectConfig,
} from "./project-config";

export interface ResolverFileIndex {
  /** Parsed source files (graph nodes). */
  analysed: ReadonlySet<string>;
  /** Stored files that are not parsed (JSON, CSS, config, ...). */
  otherStored: ReadonlySet<string>;
  /** Files in the snapshot that were skipped/failed, with the reason. */
  unavailable: ReadonlyMap<string, string>;
  /** True when the snapshot is not COMPLETE. */
  partialSnapshot: boolean;
}

export interface ResolutionResult {
  status: ResolutionStatus;
  targetPath: string | null;
  targetAnalysed: boolean;
  externalPackage: string | null;
  reason: string;
  candidates: string[];
  evidence: string[];
}

export interface ResolveRequest {
  sourcePath: string;
  specifier: string;
  kind: DependencyKind;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** JavaScript-style extensions that TypeScript sources commonly import as. */
const EMITTED_TO_SOURCE: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
};

const BUILTINS = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "")),
);

interface ProbeResult {
  hits: string[];
  unavailable: Array<{ path: string; reason: string }>;
}

export class ModuleResolver {
  constructor(
    private readonly index: ResolverFileIndex,
    private readonly config: ProjectConfig,
  ) {}

  resolve(request: ResolveRequest): ResolutionResult {
    const { sourcePath, kind } = request;
    const original = request.specifier;

    if (original.length === 0) {
      return this.unresolved("The module specifier is empty.");
    }

    // Query strings and fragments (bundler features) are ignored for lookup only.
    const specifier = original.replace(/[?#].*$/, "") || original;

    if (
      /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier) &&
      !specifier.startsWith("node:")
    ) {
      return this.unresolved(
        `The "${specifier.split(":")[0]}:" URL specifier cannot be resolved statically.`,
      );
    }

    if (specifier.startsWith("/")) {
      return this.unresolved(
        "Absolute path specifiers are not resolved against the repository.",
      );
    }

    if (isRelativeSpecifier(specifier)) {
      return this.resolveRelative(sourcePath, specifier);
    }

    if (specifier.startsWith("node:")) {
      return this.builtin(specifier);
    }

    if (specifier.startsWith("#")) {
      return this.resolvePackageImports(sourcePath, specifier, kind);
    }

    const tsconfig = findNearestTsConfig(this.config, sourcePath);

    if (tsconfig) {
      const match = this.matchAlias(tsconfig.aliases, specifier);

      if (match) {
        return this.resolveAlias(
          tsconfig.path,
          tsconfig.pathsBase,
          match,
          specifier,
        );
      }

      if (tsconfig.baseUrl !== null) {
        const joined = joinPath(tsconfig.baseUrl, specifier);

        if (!joined.escapedRoot) {
          const probe = this.probe(joined.path);

          if (probe.hits.length > 0) {
            return this.fromHits(probe, [
              `resolved through baseUrl "${tsconfig.baseUrl || "."}" in ${tsconfig.path}`,
            ]);
          }
        }
      }
    }

    const name = packageNameOf(specifier);

    if (BUILTINS.has(specifier) || BUILTINS.has(name)) {
      return this.builtin(`node:${BUILTINS.has(specifier) ? specifier : name}`);
    }

    const workspaceDir = this.config.workspacePackages.get(name);
    if (workspaceDir !== undefined) {
      return this.resolveWorkspacePackage(name, workspaceDir, specifier, kind);
    }

    return this.external(sourcePath, name);
  }

  // ---------- relative ----------

  private resolveRelative(
    sourcePath: string,
    specifier: string,
  ): ResolutionResult {
    const dir = sourcePath.includes("/")
      ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
      : "";
    const joined = joinPath(dir, specifier);

    if (joined.escapedRoot) {
      return this.unresolved(
        "The relative specifier points outside the repository root.",
      );
    }

    // Bare "." or ".." that lands on the repository root.
    const probe = this.probe(joined.path);
    return this.fromHits(probe, [`relative to ${sourcePath}`]);
  }

  // ---------- aliases ----------

  private matchAlias(
    aliases: readonly PathAlias[],
    specifier: string,
  ): { alias: PathAlias; wildcard: string | null } | null {
    const exact = aliases.find((alias) => alias.pattern === specifier);
    if (exact) return { alias: exact, wildcard: null };

    let best: {
      alias: PathAlias;
      wildcard: string;
      prefixLength: number;
    } | null = null;

    for (const alias of aliases) {
      const star = alias.pattern.indexOf("*");
      if (star === -1) continue;

      const prefix = alias.pattern.slice(0, star);
      const suffix = alias.pattern.slice(star + 1);

      if (
        specifier.length >= prefix.length + suffix.length &&
        specifier.startsWith(prefix) &&
        specifier.endsWith(suffix)
      ) {
        if (!best || prefix.length > best.prefixLength) {
          best = {
            alias,
            wildcard: specifier.slice(
              prefix.length,
              specifier.length - suffix.length,
            ),
            prefixLength: prefix.length,
          };
        }
      }
    }

    return best ? { alias: best.alias, wildcard: best.wildcard } : null;
  }

  private resolveAlias(
    configPath: string,
    base: string,
    match: { alias: PathAlias; wildcard: string | null },
    specifier: string,
  ): ResolutionResult {
    const evidence = [`alias "${match.alias.pattern}" from ${configPath}`];
    const unavailable: ProbeResult["unavailable"] = [];

    // TypeScript semantics: substitutions are tried in order; the first that
    // yields a file wins. Several files from one substitution is ambiguous.
    for (const substitution of match.alias.substitutions) {
      const target =
        match.wildcard === null
          ? substitution
          : substitution.replace("*", match.wildcard);
      const joined = joinPath(base, target);
      if (joined.escapedRoot) continue;

      const probe = this.probe(joined.path);
      unavailable.push(...probe.unavailable);

      if (probe.hits.length > 0) {
        return this.fromHits(probe, [
          ...evidence,
          `substitution "${substitution}"`,
        ]);
      }
    }

    return this.fromHits({ hits: [], unavailable }, evidence, {
      missing: `Alias "${match.alias.pattern}" matched "${specifier}" but none of its targets exist in the snapshot.`,
    });
  }

  // ---------- packages ----------

  private resolveWorkspacePackage(
    name: string,
    dir: string,
    specifier: string,
    kind: DependencyKind,
  ): ResolutionResult {
    const pkg = this.config.packages.get(dir);
    const subpath = specifier.slice(name.length); // "" or "/sub/path"
    const evidence = [
      `workspace package "${name}" (${pkg?.path ?? `${dir}/package.json`})`,
    ];

    if (!pkg)
      return this.unresolved(
        "Workspace package metadata is unavailable.",
        evidence,
      );

    const conditions =
      kind === "REQUIRE"
        ? ["types", "require", "node", "default"]
        : ["types", "import", "node", "default"];

    const candidatePaths: string[] = [];

    if (pkg.exports !== undefined && pkg.exports !== null) {
      const targets = resolveExportsMap(
        pkg.exports,
        subpath === "" ? "." : `.${subpath}`,
        conditions,
      );
      for (const target of targets) {
        const joined = joinPath(dir, target);
        if (!joined.escapedRoot) candidatePaths.push(joined.path);
      }
      evidence.push('resolved through the package "exports" field');
    } else if (subpath === "") {
      for (const field of [pkg.types, pkg.module, pkg.main]) {
        if (!field) continue;
        const joined = joinPath(dir, field);
        if (!joined.escapedRoot) candidatePaths.push(joined.path);
      }
      candidatePaths.push(dir === "" ? "index" : `${dir}/index`);
      evidence.push(
        "resolved through package main/module/types fields or index file",
      );
    } else {
      const joined = joinPath(dir, subpath.slice(1));
      if (!joined.escapedRoot) candidatePaths.push(joined.path);
    }

    const unavailable: ProbeResult["unavailable"] = [];

    for (const candidate of candidatePaths) {
      const probe = this.probe(candidate);
      unavailable.push(...probe.unavailable);
      if (probe.hits.length > 0) return this.fromHits(probe, evidence);
    }

    return this.fromHits({ hits: [], unavailable }, evidence, {
      missing: `Workspace package "${name}" was found, but its entry for "${specifier}" is not present in the snapshot (it may be build output).`,
    });
  }

  private resolvePackageImports(
    sourcePath: string,
    specifier: string,
    kind: DependencyKind,
  ): ResolutionResult {
    const pkg = findNearestPackage(this.config, sourcePath);

    if (!pkg || pkg.imports === undefined || pkg.imports === null) {
      return this.unresolved(
        `No package.json "imports" field is available to resolve "${specifier}".`,
      );
    }

    const conditions =
      kind === "REQUIRE"
        ? ["types", "require", "node", "default"]
        : ["types", "import", "node", "default"];

    const targets = resolveExportsMap(pkg.imports, specifier, conditions);
    const evidence = [`package.json "imports" in ${pkg.path}`];

    if (targets.length === 0) {
      return this.unresolved(
        `"${specifier}" is not defined in the package.json "imports" field.`,
        evidence,
      );
    }

    const unavailable: ProbeResult["unavailable"] = [];

    for (const target of targets) {
      if (!target.startsWith("./")) {
        return {
          status: "EXTERNAL",
          targetPath: null,
          targetAnalysed: false,
          externalPackage: packageNameOf(target),
          reason: `"${specifier}" maps to the external package "${packageNameOf(target)}".`,
          candidates: [],
          evidence,
        };
      }

      const joined = joinPath(pkg.dir, target);
      if (joined.escapedRoot) continue;
      const probe = this.probe(joined.path);
      unavailable.push(...probe.unavailable);
      if (probe.hits.length > 0) return this.fromHits(probe, evidence);
    }

    return this.fromHits({ hits: [], unavailable }, evidence, {
      missing: `"${specifier}" is defined in package.json "imports" but its target is not present in the snapshot.`,
    });
  }

  private builtin(name: string): ResolutionResult {
    return {
      status: "EXTERNAL",
      targetPath: null,
      targetAnalysed: false,
      externalPackage: name,
      reason: `"${name}" is a Node.js built-in module.`,
      candidates: [],
      evidence: ["Node.js built-in module"],
    };
  }

  private external(sourcePath: string, packageName: string): ResolutionResult {
    const pkg: PackageInfo | null = findNearestPackage(this.config, sourcePath);
    const evidence = [
      !pkg
        ? "no package.json found for the importing file"
        : pkg.dependencies.has(packageName)
          ? `"${packageName}" is declared in ${pkg.path}`
          : `"${packageName}" is not declared in ${pkg.path}`,
    ];

    return {
      status: "EXTERNAL",
      targetPath: null,
      targetAnalysed: false,
      externalPackage: packageName,
      reason: `"${packageName}" is an external package; its contents are not part of this snapshot.`,
      candidates: [],
      evidence,
    };
  }

  // ---------- file probing ----------

  private exists(path: string): boolean {
    return this.index.analysed.has(path) || this.index.otherStored.has(path);
  }

  /**
   * Finds files for a base path in precedence tiers. Within one tier, more
   * than one match is reported as ambiguous rather than picking a winner.
   */
  private probe(basePath: string): ProbeResult {
    const tiers: string[][] = [];
    const extension = basePath.includes(".")
      ? basePath.slice(basePath.lastIndexOf("."))
      : "";

    // 1. The exact file, plus the TypeScript source behind a JS-style import.
    tiers.push([
      basePath,
      ...(EMITTED_TO_SOURCE[extension] ?? []).map(
        (mapped) =>
          basePath.slice(0, basePath.length - extension.length) + mapped,
      ),
    ]);

    // 2. Extension probing.
    tiers.push(SOURCE_EXTENSIONS.map((ext) => `${basePath}${ext}`));
    tiers.push([`${basePath}.d.ts`]);
    tiers.push([`${basePath}.json`]);

    // 3. Directory: package.json entry, then index files.
    const dirPackage = this.config.packages.get(basePath);
    if (dirPackage) {
      for (const field of [
        dirPackage.types,
        dirPackage.module,
        dirPackage.main,
      ]) {
        if (!field) continue;
        const joined = joinPath(basePath, field);
        if (joined.escapedRoot) continue;
        const entry = joined.path;
        const entryExtension = entry.includes(".")
          ? entry.slice(entry.lastIndexOf("."))
          : "";
        tiers.push([
          entry,
          ...(EMITTED_TO_SOURCE[entryExtension] ?? []).map(
            (mapped) =>
              entry.slice(0, entry.length - entryExtension.length) + mapped,
          ),
        ]);
        tiers.push(SOURCE_EXTENSIONS.map((ext) => `${entry}${ext}`));
      }
    }

    const indexBase = basePath === "" ? "index" : `${basePath}/index`;
    tiers.push(SOURCE_EXTENSIONS.map((ext) => `${indexBase}${ext}`));
    tiers.push([`${indexBase}.d.ts`]);
    tiers.push([`${indexBase}.json`]);

    const normalised = tiers.map((tier) =>
      tier.map((candidate) => normalisePath(candidate).path),
    );

    for (const tier of normalised) {
      const hits = [
        ...new Set(tier.filter((candidate) => this.exists(candidate))),
      ];
      if (hits.length > 0) return { hits: hits.sort(), unavailable: [] };
    }

    const unavailable: ProbeResult["unavailable"] = [];
    for (const candidate of new Set(normalised.flat())) {
      const reason = this.index.unavailable.get(candidate);
      if (reason !== undefined) unavailable.push({ path: candidate, reason });
    }

    return {
      hits: [],
      unavailable: unavailable.sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  // ---------- result builders ----------

  private fromHits(
    probe: ProbeResult,
    evidence: string[],
    options: { missing?: string } = {},
  ): ResolutionResult {
    if (probe.hits.length === 1) {
      const target = probe.hits[0];
      return {
        status: "RESOLVED",
        targetPath: target,
        targetAnalysed: this.index.analysed.has(target),
        externalPackage: null,
        reason: `Resolved to ${target}.`,
        candidates: [target],
        evidence,
      };
    }

    if (probe.hits.length > 1) {
      return {
        status: "AMBIGUOUS",
        targetPath: null,
        targetAnalysed: false,
        externalPackage: null,
        reason: `More than one file matches (${probe.hits.join(", ")}); no target was chosen.`,
        candidates: probe.hits,
        evidence,
      };
    }

    const base = options.missing ?? "No matching file exists in the snapshot.";
    const notes: string[] = [];

    if (probe.unavailable.length > 0) {
      notes.push(
        `A matching file exists in the snapshot but was not analysed: ${probe.unavailable
          .map((entry) => `${entry.path} (${entry.reason})`)
          .join("; ")}.`,
      );
    }

    if (this.index.partialSnapshot) {
      notes.push(
        "The snapshot is partial, so the target may exist in files that were not stored.",
      );
    }

    return {
      status: "UNRESOLVED",
      targetPath: null,
      targetAnalysed: false,
      externalPackage: null,
      reason: [base, ...notes].join(" "),
      candidates: probe.unavailable.map((entry) => entry.path),
      evidence,
    };
  }

  private unresolved(
    reason: string,
    evidence: string[] = [],
  ): ResolutionResult {
    return {
      status: "UNRESOLVED",
      targetPath: null,
      targetAnalysed: false,
      externalPackage: null,
      reason,
      candidates: [],
      evidence,
    };
  }
}

/**
 * Resolves a package.json "exports"/"imports" map entry to candidate target
 * strings (in priority order). Pure data interpretation; supports exact keys,
 * single-"*" patterns, arrays and nested conditions.
 */
export function resolveExportsMap(
  map: unknown,
  subpath: string,
  conditions: readonly string[],
): string[] {
  let entries: Record<string, unknown>;

  if (typeof map === "string" || Array.isArray(map)) {
    entries = { ".": map };
  } else if (typeof map === "object" && map !== null) {
    const record = map as Record<string, unknown>;
    const keys = Object.keys(record);
    const isSubpathMap =
      keys.length > 0 &&
      keys.every((key) => key.startsWith(".") || key.startsWith("#"));
    entries = isSubpathMap ? record : { ".": record };
  } else {
    return [];
  }

  let target: unknown;
  let wildcard: string | null = null;

  if (Object.prototype.hasOwnProperty.call(entries, subpath)) {
    target = entries[subpath];
  } else {
    let bestPrefix = -1;

    for (const [key, value] of Object.entries(entries)) {
      const star = key.indexOf("*");
      if (star === -1) continue;
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);

      if (
        subpath.length >= prefix.length + suffix.length &&
        subpath.startsWith(prefix) &&
        subpath.endsWith(suffix) &&
        prefix.length > bestPrefix
      ) {
        bestPrefix = prefix.length;
        target = value;
        wildcard = subpath.slice(prefix.length, subpath.length - suffix.length);
      }
    }
  }

  if (target === undefined) return [];

  const results: string[] = [];

  const collect = (value: unknown) => {
    if (typeof value === "string") {
      results.push(wildcard === null ? value : value.replace(/\*/g, wildcard));
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item);
    } else if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      // Package author's key order decides priority, as in Node.js.
      for (const key of Object.keys(record)) {
        if (conditions.includes(key)) collect(record[key]);
      }
    }
  };

  collect(target);
  return results;
}
