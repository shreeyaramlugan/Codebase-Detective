// features/code-intelligence/resolution/project-config.ts
//
// Reads package.json / tsconfig.json / jsconfig.json from the stored
// snapshot. Files are parsed as data (JSON / JSONC); nothing is executed and
// no module is ever loaded. Invalid or missing configuration yields
// diagnostics, never fabricated settings.
import ts from "typescript";

import { ANALYSIS_LIMITS, type DiagnosticRecord } from "../contracts";
import {
  ancestorDirectories,
  dirname,
  isRelativeSpecifier,
  joinPath,
} from "./path-utils";

export interface ConfigInput {
  path: string;
  text: string;
}

export interface PackageInfo {
  dir: string;
  path: string;
  name: string | null;
  main: string | null;
  module: string | null;
  types: string | null;
  exports: unknown;
  imports: unknown;
  type: "module" | "commonjs" | null;
  dependencies: ReadonlySet<string>;
}

export interface PathAlias {
  pattern: string;
  substitutions: string[];
}

export interface TsConfigInfo {
  dir: string;
  path: string;
  /** Repository-relative directory used as the base for non-relative lookups. */
  baseUrl: string | null;
  /** Repository-relative directory that `paths` substitutions resolve against. */
  pathsBase: string;
  aliases: PathAlias[];
}

export interface ProjectConfig {
  packages: Map<string, PackageInfo>;
  tsconfigs: Map<string, TsConfigInfo>;
  /** Package name -> directory, for packages defined inside the repository. */
  workspacePackages: Map<string, string>;
  diagnostics: DiagnosticRecord[];
}

const TSCONFIG_NAME = /^(tsconfig|jsconfig)(\..+)?\.json$/;

export function isConfigFilePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === "package.json" || TSCONFIG_NAME.test(name);
}

function configDiagnostic(
  severity: DiagnosticRecord["severity"],
  code: string,
  message: string,
  path: string | null,
  details: Record<string, unknown> | null = null,
): DiagnosticRecord {
  return {
    severity,
    source: "CONFIG",
    code,
    message,
    path,
    line: null,
    column: null,
    details,
  };
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parsePackageJson(
  input: ConfigInput,
  diagnostics: DiagnosticRecord[],
): PackageInfo | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(input.text);
  } catch {
    diagnostics.push(
      configDiagnostic(
        "WARNING",
        "CONFIG_PARSE_ERROR",
        "package.json is not valid JSON; package metadata was ignored.",
        input.path,
      ),
    );
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    diagnostics.push(
      configDiagnostic(
        "WARNING",
        "CONFIG_INVALID",
        "package.json must contain a JSON object; package metadata was ignored.",
        input.path,
      ),
    );
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const dependencies = new Set<string>();

  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const value = record[field];
    if (typeof value === "object" && value !== null) {
      for (const name of Object.keys(value)) dependencies.add(name);
    }
  }

  return {
    dir: dirname(input.path),
    path: input.path,
    name: asStringOrNull(record.name),
    main: asStringOrNull(record.main),
    module: asStringOrNull(record.module),
    types: asStringOrNull(record.types) ?? asStringOrNull(record.typings),
    exports: record.exports,
    imports: record.imports,
    type:
      record.type === "module" || record.type === "commonjs"
        ? record.type
        : null,
    dependencies,
  };
}

interface RawTsConfig {
  extends: string[];
  baseUrl: string | undefined;
  paths: unknown;
  hasPaths: boolean;
}

function parseTsConfig(
  input: ConfigInput,
  diagnostics: DiagnosticRecord[],
): RawTsConfig | null {
  // parseConfigFileTextToJson reads JSON-with-comments as data only.
  const { config, error } = ts.parseConfigFileTextToJson(
    input.path,
    input.text,
  );

  if (error || typeof config !== "object" || config === null) {
    diagnostics.push(
      configDiagnostic(
        "WARNING",
        "CONFIG_PARSE_ERROR",
        `${input.path} could not be parsed; its path aliases were ignored.`,
        input.path,
        error
          ? {
              message: ts.flattenDiagnosticMessageText(error.messageText, "\n"),
            }
          : null,
      ),
    );
    return null;
  }

  const record = config as Record<string, unknown>;
  const options =
    typeof record.compilerOptions === "object" &&
    record.compilerOptions !== null
      ? (record.compilerOptions as Record<string, unknown>)
      : {};

  const extendsValue = record.extends;
  const extendsList =
    typeof extendsValue === "string"
      ? [extendsValue]
      : Array.isArray(extendsValue)
        ? extendsValue.filter(
            (value): value is string => typeof value === "string",
          )
        : [];

  return {
    extends: extendsList,
    baseUrl: typeof options.baseUrl === "string" ? options.baseUrl : undefined,
    paths: options.paths,
    hasPaths: "paths" in options,
  };
}

function buildAliases(
  rawPaths: unknown,
  configPath: string,
  diagnostics: DiagnosticRecord[],
): PathAlias[] {
  if (
    typeof rawPaths !== "object" ||
    rawPaths === null ||
    Array.isArray(rawPaths)
  ) {
    diagnostics.push(
      configDiagnostic(
        "WARNING",
        "CONFIG_INVALID_PATHS",
        `compilerOptions.paths in ${configPath} must be an object; path aliases were ignored.`,
        configPath,
      ),
    );
    return [];
  }

  const aliases: PathAlias[] = [];

  for (const [pattern, value] of Object.entries(rawPaths)) {
    const stars = pattern.split("*").length - 1;
    const valid =
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((entry) => typeof entry === "string") &&
      stars <= 1 &&
      (value as string[]).every((entry) => entry.split("*").length - 1 <= 1);

    if (!valid) {
      diagnostics.push(
        configDiagnostic(
          "WARNING",
          "CONFIG_INVALID_PATHS",
          `Path alias "${pattern}" in ${configPath} is invalid and was ignored.`,
          configPath,
          { pattern },
        ),
      );
      continue;
    }

    aliases.push({ pattern, substitutions: value as string[] });
  }

  return aliases;
}

export function loadProjectConfig(
  inputs: readonly ConfigInput[],
): ProjectConfig {
  const diagnostics: DiagnosticRecord[] = [];
  const packages = new Map<string, PackageInfo>();
  const workspacePackages = new Map<string, string>();
  const tsconfigs = new Map<string, TsConfigInfo>();

  const sorted = [...inputs].sort((a, b) => a.path.localeCompare(b.path));
  const byPath = new Map(sorted.map((input) => [input.path, input]));
  const rawCache = new Map<string, RawTsConfig | null>();

  for (const input of sorted) {
    if (input.text.length > ANALYSIS_LIMITS.MAX_CONFIG_BYTES) {
      diagnostics.push(
        configDiagnostic(
          "WARNING",
          "CONFIG_TOO_LARGE",
          `${input.path} is too large to read as configuration and was ignored.`,
          input.path,
        ),
      );
      continue;
    }

    if (input.path.endsWith("package.json")) {
      const info = parsePackageJson(input, diagnostics);
      if (!info) continue;
      packages.set(info.dir, info);

      if (info.name && !workspacePackages.has(info.name)) {
        workspacePackages.set(info.name, info.dir);
      }
    }
  }

  const readRaw = (path: string): RawTsConfig | null => {
    if (rawCache.has(path)) return rawCache.get(path) ?? null;
    const input = byPath.get(path);
    const raw = input ? parseTsConfig(input, diagnostics) : null;
    rawCache.set(path, raw);
    return raw;
  };

  /** Resolves the extends chain (base first), reporting unavailable links. */
  const chainFor = (path: string, seen: string[]): string[] => {
    if (seen.includes(path)) {
      diagnostics.push(
        configDiagnostic(
          "WARNING",
          "CONFIG_EXTENDS_CYCLE",
          `tsconfig extends cycle detected at ${path}.`,
          path,
        ),
      );
      return [];
    }

    const raw = readRaw(path);
    if (!raw) return [];

    const chain: string[] = [];

    for (const target of raw.extends) {
      if (!isRelativeSpecifier(target)) {
        diagnostics.push(
          configDiagnostic(
            "INFO",
            "CONFIG_EXTENDS_UNAVAILABLE",
            `${path} extends "${target}", which is a package and is not available in the snapshot; inherited settings were ignored.`,
            path,
            { extends: target },
          ),
        );
        continue;
      }

      const joined = joinPath(
        dirname(path),
        target.endsWith(".json") ? target : `${target}.json`,
      );
      if (joined.escapedRoot || !byPath.has(joined.path)) {
        diagnostics.push(
          configDiagnostic(
            "WARNING",
            "CONFIG_EXTENDS_UNAVAILABLE",
            `${path} extends "${target}", which was not found in the snapshot; inherited settings were ignored.`,
            path,
            { extends: target },
          ),
        );
        continue;
      }

      chain.push(...chainFor(joined.path, [...seen, path]));
    }

    chain.push(path);
    return chain;
  };

  for (const input of sorted) {
    const name = input.path.slice(input.path.lastIndexOf("/") + 1);
    if (!TSCONFIG_NAME.test(name)) continue;
    if (input.text.length > ANALYSIS_LIMITS.MAX_CONFIG_BYTES) continue;

    // Only the canonical config for a directory drives resolution.
    if (name !== "tsconfig.json" && name !== "jsconfig.json") continue;

    const dir = dirname(input.path);
    const existing = tsconfigs.get(dir);
    if (existing && name === "jsconfig.json") continue; // tsconfig wins

    let baseUrl: string | null = null;
    let aliases: PathAlias[] = [];
    let pathsBase = dir;

    for (const link of chainFor(input.path, [])) {
      const raw = readRaw(link);
      if (!raw) continue;

      if (raw.baseUrl !== undefined) {
        const joined = joinPath(dirname(link), raw.baseUrl);
        baseUrl = joined.escapedRoot ? null : joined.path;
      }

      if (raw.hasPaths) {
        aliases = buildAliases(raw.paths, link, diagnostics);
        pathsBase = dirname(link);
      }
    }

    tsconfigs.set(dir, {
      dir,
      path: input.path,
      baseUrl,
      pathsBase: baseUrl ?? pathsBase,
      aliases,
    });
  }

  return { packages, tsconfigs, workspacePackages, diagnostics };
}

export function findNearestTsConfig(
  config: ProjectConfig,
  filePath: string,
): TsConfigInfo | null {
  for (const dir of ancestorDirectories(filePath)) {
    const found = config.tsconfigs.get(dir);
    if (found) return found;
  }
  return null;
}

export function findNearestPackage(
  config: ProjectConfig,
  filePath: string,
): PackageInfo | null {
  for (const dir of ancestorDirectories(filePath)) {
    const found = config.packages.get(dir);
    if (found) return found;
  }
  return null;
}
