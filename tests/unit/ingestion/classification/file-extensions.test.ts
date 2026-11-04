import { describe, expect, it } from "vitest";
import { getFileExtensionClassification } from "@/lib/ingestion/classification/file-extensions";

describe("getFileExtensionClassification", () => {
  describe("source files", () => {
    it.each([
      "src/index.js",
      "src/component.jsx",
      "src/index.ts",
      "src/component.tsx",
      "src/module.mjs",
      "src/module.cjs",
      "src/module.mts",
      "src/module.cts",
    ])("classifies %s as source", (path) => {
      expect(getFileExtensionClassification(path).category).toBe("SOURCE");
    });

    it("classifies declaration files as TypeScript source", () => {
      expect(getFileExtensionClassification("types/index.d.ts")).toEqual({
        category: "SOURCE",
        extension: ".ts",
      });
    });
  });

  describe("documentation files", () => {
    it.each([
      "README",
      "README.md",
      "README.mdx",
      "LICENSE",
      "LICENSE.md",
      "LICENCE",
      "CONTRIBUTING",
      "CONTRIBUTING.md",
      "SECURITY",
      "SECURITY.md",
      "CHANGELOG",
      "CHANGELOG.md",
      "CHANGES",
      "CHANGES.md",
    ])("classifies documentation filename %s", (path) => {
      expect(getFileExtensionClassification(path).category).toBe(
        "DOCUMENTATION",
      );
    });

    it.each([".md", ".mdx", ".txt", ".rst"])(
      "classifies documentation extension %s",
      (extension) => {
        expect(
          getFileExtensionClassification(`docs/guide${extension}`).category,
        ).toBe("DOCUMENTATION");
      },
    );
  });

  describe("configuration files", () => {
    it.each([
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
    ])("classifies configuration extension %s", (extension) => {
      expect(
        getFileExtensionClassification(`config/file${extension}`).category,
      ).toBe("CONFIGURATION");
    });

    it.each([
      "Dockerfile",
      "Makefile",
      "justfile",
      "Procfile",
      "package.json",
      "tsconfig.json",
      "jsconfig.json",
      "babel.config.js",
      "eslint.config.js",
      "prettier.config.js",
      "vite.config.ts",
      "vitest.config.ts",
      "next.config.js",
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
    ])("classifies configuration filename %s", (path) => {
      expect(getFileExtensionClassification(path).category).toBe(
        "CONFIGURATION",
      );
    });
  });

  describe("unsupported files", () => {
    it.each([
      "image.png",
      "document.pdf",
      "program.exe",
      "archive.zip",
      "unknown.xyz",
      "extensionless",
    ])("does not classify unsupported file %s", (path) => {
      expect(getFileExtensionClassification(path)).toMatchObject({
        category: null,
      });
    });
  });

  describe("classification precedence and casing", () => {
    it("classifies known JavaScript configuration files as configuration", () => {
      expect(getFileExtensionClassification("next.config.mjs").category).toBe(
        "CONFIGURATION",
      );
    });

    it("handles uppercase extensions", () => {
      expect(getFileExtensionClassification("src/APP.TSX").category).toBe(
        "SOURCE",
      );
    });

    it("handles uppercase documentation filenames", () => {
      expect(getFileExtensionClassification("README.MD").category).toBe(
        "DOCUMENTATION",
      );
    });

    it("classifies files in nested directories by filename", () => {
      expect(
        getFileExtensionClassification("project/config/tsconfig.json").category,
      ).toBe("CONFIGURATION");
    });
  });
});
