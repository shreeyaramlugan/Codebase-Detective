import type { IngestionFileCategory } from "./classification.types";

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

const DOCUMENTATION_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);

const CONFIGURATION_EXTENSIONS = new Set([
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".html",
  ".css",
  ".scss",
  ".sass",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".xml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".graphql",
  ".gql",
  ".prisma",
  ".dockerfile",
]);

const CONFIGURATION_FILENAMES = new Set([
  "dockerfile",
  "makefile",
  "justfile",
  "procfile",
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "babel.config.js",
  "babel.config.cjs",
  "babel.config.mjs",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "vite.config.js",
  "vite.config.ts",
  "vitest.config.js",
  "vitest.config.ts",
  "next.config.js",
  "next.config.ts",
  "next.config.mjs",
  "next.config.cjs",
  "postcss.config.js",
  "postcss.config.mjs",
  "tailwind.config.js",
  "tailwind.config.ts",
  "prisma.config.ts",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lock",
  ".env.example",
  ".env.sample",
  ".env.template",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc",
  ".npmrc.example",
]);

const DOCUMENTATION_FILENAMES = new Set([
  "readme",
  "readme.md",
  "readme.mdx",
  "license",
  "license.md",
  "licence",
  "licence.md",
  "contributing",
  "contributing.md",
  "security",
  "security.md",
  "changelog",
  "changelog.md",
  "changes",
  "changes.md",
]);

export interface FileExtensionClassification {
  category: IngestionFileCategory | null;
  extension: string | null;
}
export function getFileExtensionClassification(
  path: string,
): FileExtensionClassification {
  const segments = path.split("/");
  const filename = segments[segments.length - 1].toLowerCase();

  const dotIndex = filename.lastIndexOf(".");
  const extension = dotIndex > 0 ? filename.slice(dotIndex) : null;

  // Known configuration filenames take precedence over source extensions.
  if (CONFIGURATION_FILENAMES.has(filename)) {
    return { category: "CONFIGURATION", extension };
  }

  // Known documentation filenames.
  if (DOCUMENTATION_FILENAMES.has(filename)) {
    return { category: "DOCUMENTATION", extension };
  }

  // TypeScript declaration files.
  if (filename.endsWith(".d.ts")) {
    return { category: "SOURCE", extension: ".ts" };
  }

  // Source code.
  if (SOURCE_EXTENSIONS.has(extension ?? "")) {
    return { category: "SOURCE", extension };
  }

  // Documentation extensions.
  if (DOCUMENTATION_EXTENSIONS.has(extension ?? "")) {
    return { category: "DOCUMENTATION", extension };
  }

  // Configuration extensions.
  if (CONFIGURATION_EXTENSIONS.has(extension ?? "")) {
    return { category: "CONFIGURATION", extension };
  }

  return { category: null, extension };
}
