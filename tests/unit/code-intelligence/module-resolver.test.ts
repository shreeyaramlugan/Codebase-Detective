// tests/unit/code-intelligence/module-resolver.test.ts
import { describe, expect, it } from "vitest";

import {
  ModuleResolver,
  resolveExportsMap,
} from "@/features/code-intelligence/resolution/module-resolver";
import { loadProjectConfig } from "@/features/code-intelligence/resolution/project-config";
import {
  TSCONFIG_ALIAS,
  analyze,
  fixtures,
  type Project,
} from "../../fixtures/code-intelligence/projects";

function resolverFor(
  files: Project,
  options: { unavailable?: Record<string, string>; partial?: boolean } = {},
) {
  const analysed = new Set(
    Object.keys(files).filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p)),
  );
  const configs = Object.entries(files)
    .filter(([p]) => p.endsWith(".json"))
    .map(([path, text]) => ({ path, text }));
  const config = loadProjectConfig(configs);
  const resolver = new ModuleResolver(
    {
      analysed,
      otherStored: new Set(Object.keys(files).filter((p) => !analysed.has(p))),
      unavailable: new Map(Object.entries(options.unavailable ?? {})),
      partialSnapshot: options.partial ?? false,
    },
    config,
  );
  return { resolver, config };
}

const resolve = (
  files: Project,
  specifier: string,
  from = "src/a.ts",
  kind: "IMPORT" | "REQUIRE" = "IMPORT",
  options?: Parameters<typeof resolverFor>[1],
) =>
  resolverFor(files, options).resolver.resolve({
    sourcePath: from,
    specifier,
    kind,
  });

describe("relative resolution", () => {
  const files: Project = {
    "src/a.ts": "",
    "src/b.ts": "",
    "src/util.js": "",
    "src/nested/index.ts": "",
    "src/other.ts": "",
    "src/other.js": "",
    "src/dir/index.ts": "",
    "src/dir/index.js": "",
    "src/data.json": "{}",
    "src/emitted.ts": "",
    "lib/deep/x.ts": "",
  };

  it("resolves extensionless, extension and directory-index imports", () => {
    expect(resolve(files, "./b")).toMatchObject({
      status: "RESOLVED",
      targetPath: "src/b.ts",
    });
    expect(resolve(files, "./b.ts")).toMatchObject({
      status: "RESOLVED",
      targetPath: "src/b.ts",
    });
    expect(resolve(files, "./nested")).toMatchObject({
      status: "RESOLVED",
      targetPath: "src/nested/index.ts",
    });
    expect(resolve(files, "../lib/deep/x")).toMatchObject({
      status: "RESOLVED",
      targetPath: "lib/deep/x.ts",
    });
  });

  it("maps JS-style specifiers onto TypeScript sources", () => {
    expect(resolve(files, "./emitted.js")).toMatchObject({
      status: "RESOLVED",
      targetPath: "src/emitted.ts",
    });
  });

  it("resolves non-source files that exist in the snapshot", () => {
    const result = resolve(files, "./data.json");
    expect(result).toMatchObject({
      status: "RESOLVED",
      targetPath: "src/data.json",
      targetAnalysed: false,
    });
  });

  it("reports AMBIGUOUS instead of guessing", () => {
    const result = resolve(files, "./other");
    expect(result.status).toBe("AMBIGUOUS");
    expect(result.targetPath).toBeNull();
    expect(result.candidates).toEqual(["src/other.js", "src/other.ts"]);

    expect(resolve(files, "./dir").status).toBe("AMBIGUOUS");
  });

  it("keeps unresolved imports unresolved", () => {
    const result = resolve(files, "./missing");
    expect(result.status).toBe("UNRESOLVED");
    expect(result.targetPath).toBeNull();
  });

  it("does not resolve paths that escape the repository root", () => {
    const result = resolve(files, "../../../etc/passwd");
    expect(result.status).toBe("UNRESOLVED");
    expect(result.reason).toContain("outside the repository");
  });

  it("explains when the target exists but was not analysed", () => {
    const result = resolve(files, "./big", "src/a.ts", "IMPORT", {
      unavailable: { "src/big.ts": "SKIPPED: file too large" },
    });
    expect(result.status).toBe("UNRESOLVED");
    expect(result.reason).toContain("src/big.ts");
    expect(result.reason).toContain("file too large");
  });

  it("notes partial snapshots on unresolved results", () => {
    const result = resolve(files, "./missing", "src/a.ts", "IMPORT", {
      partial: true,
    });
    expect(result.reason).toContain("partial");
  });

  it("ignores bundler query strings for lookup only", () => {
    expect(resolve(files, "./b?raw")).toMatchObject({
      status: "RESOLVED",
      targetPath: "src/b.ts",
    });
  });
});

describe("aliases and configuration", () => {
  const files: Project = {
    "tsconfig.json": TSCONFIG_ALIAS,
    "src/a.ts": "",
    "src/util.ts": "",
    "src/lib/index.ts": "",
  };

  it("resolves wildcard and exact aliases", () => {
    expect(resolve(files, "@/util")).toMatchObject({
      status: "RESOLVED",
      targetPath: "src/util.ts",
    });
    expect(resolve(files, "@lib")).toMatchObject({
      status: "RESOLVED",
      targetPath: "src/lib/index.ts",
    });
  });

  it("keeps the alias unresolved when no target exists", () => {
    const result = resolve(files, "@/nothing");
    expect(result.status).toBe("UNRESOLVED");
    expect(result.targetPath).toBeNull();
  });

  it("resolves bare specifiers through baseUrl", () => {
    expect(resolve(files, "src/util")).toMatchObject({
      status: "RESOLVED",
      targetPath: "src/util.ts",
    });
  });

  it("supports tsconfig comments, extends and nested configs", () => {
    const project: Project = {
      "tsconfig.base.json": `{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["app/*"] } } }`,
      "tsconfig.json": `{ "extends": "./tsconfig.base.json" }`,
      "app/a.ts": "",
      "app/x.ts": "",
    };
    // tsconfig.base.json is not a canonical config name, so it is loaded only
    // when it is part of the extends chain.
    const { config } = resolverFor(project);
    expect(config.tsconfigs.get("")?.aliases).toEqual([
      { pattern: "~/*", substitutions: ["app/*"] },
    ]);
    expect(resolve(project, "~/x", "app/a.ts")).toMatchObject({
      targetPath: "app/x.ts",
    });
  });

  it("reports invalid alias configuration without fabricating resolutions", () => {
    const project: Project = {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          paths: { "@/*": "src/*", "bad/*/*": ["x"], "ok/*": ["src/*"] },
        },
      }),
      "src/a.ts": "",
      "src/util.ts": "",
    };
    const { config, resolver } = resolverFor(project);
    expect(
      config.diagnostics.filter((d) => d.code === "CONFIG_INVALID_PATHS"),
    ).toHaveLength(2);
    expect(
      resolver.resolve({
        sourcePath: "src/a.ts",
        specifier: "@/util",
        kind: "IMPORT",
      }).status,
    ).toBe("EXTERNAL");
    expect(
      resolver.resolve({
        sourcePath: "src/a.ts",
        specifier: "ok/util",
        kind: "IMPORT",
      }).targetPath,
    ).toBe("src/util.ts");
  });

  it("reports unparsable configuration", () => {
    const { config } = resolverFor({
      "tsconfig.json": "{ nope",
      "package.json": "[]",
    });
    const codes = config.diagnostics.map((d) => d.code);
    expect(codes).toContain("CONFIG_PARSE_ERROR");
    expect(codes).toContain("CONFIG_INVALID");
  });

  it("reports an unavailable extends target", () => {
    const { config } = resolverFor({
      "tsconfig.json": `{ "extends": "./missing.json" }`,
    });
    expect(
      config.diagnostics.some((d) => d.code === "CONFIG_EXTENDS_UNAVAILABLE"),
    ).toBe(true);
  });

  it("emits a documented diagnostic when no tsconfig exists", () => {
    const { records } = analyze({ "src/a.ts": `import x from "@/y";` });
    expect(records.diagnostics.some((d) => d.code === "CONFIG_MISSING")).toBe(
      true,
    );
    expect(records.dependencies[0].status).toBe("EXTERNAL");
  });
});

describe("packages and external modules", () => {
  it("classifies external packages and built-ins", () => {
    const files: Project = {
      "package.json": JSON.stringify({
        name: "app",
        dependencies: { react: "1" },
      }),
      "src/a.ts": "",
    };
    const react = resolve(files, "react");
    expect(react).toMatchObject({
      status: "EXTERNAL",
      externalPackage: "react",
    });
    expect(react.evidence[0]).toContain("is declared");
    expect(resolve(files, "lodash/fp").externalPackage).toBe("lodash");
    expect(resolve(files, "@scope/pkg/sub").externalPackage).toBe("@scope/pkg");
    expect(resolve(files, "lodash").evidence[0]).toContain("not declared");
    expect(resolve(files, "node:fs")).toMatchObject({
      status: "EXTERNAL",
      externalPackage: "node:fs",
    });
    expect(resolve(files, "fs/promises")).toMatchObject({
      status: "EXTERNAL",
      externalPackage: "node:fs/promises",
    });
  });

  it("resolves workspace packages through exports, main and index", () => {
    const files: Project = {
      "package.json": JSON.stringify({ name: "root" }),
      "packages/core/package.json": JSON.stringify({
        name: "@acme/core",
        exports: {
          ".": { import: "./src/index.ts", require: "./src/index.cjs" },
          "./utils/*": "./src/utils/*.ts",
        },
      }),
      "packages/core/src/index.ts": "",
      "packages/core/src/utils/str.ts": "",
      "packages/util/package.json": JSON.stringify({
        name: "@acme/util",
        main: "lib/main.js",
      }),
      "packages/util/lib/main.js": "",
      "packages/idx/package.json": JSON.stringify({ name: "idx" }),
      "packages/idx/index.ts": "",
      "app/a.ts": "",
    };
    const at = (spec: string, kind: "IMPORT" | "REQUIRE" = "IMPORT") =>
      resolve(files, spec, "app/a.ts", kind);

    expect(at("@acme/core")).toMatchObject({
      status: "RESOLVED",
      targetPath: "packages/core/src/index.ts",
    });
    expect(at("@acme/core/utils/str")).toMatchObject({
      targetPath: "packages/core/src/utils/str.ts",
    });
    expect(at("@acme/util")).toMatchObject({
      targetPath: "packages/util/lib/main.js",
    });
    expect(at("idx")).toMatchObject({ targetPath: "packages/idx/index.ts" });
    // require condition points at a file that is not in the snapshot.
    expect(at("@acme/core", "REQUIRE").status).toBe("UNRESOLVED");
    expect(at("@acme/core").evidence.join(" ")).toContain("exports");
  });

  it("uses a directory's package.json main for directory imports", () => {
    const files: Project = {
      "src/a.ts": "",
      "src/lib/package.json": JSON.stringify({ main: "./entry.js" }),
      "src/lib/entry.js": "",
    };
    expect(resolve(files, "./lib")).toMatchObject({
      targetPath: "src/lib/entry.js",
    });
  });

  it("resolves package.json imports (#internal)", () => {
    const files: Project = {
      "package.json": JSON.stringify({
        imports: { "#utils/*": "./src/utils/*.ts", "#dep": "lodash" },
      }),
      "src/a.ts": "",
      "src/utils/x.ts": "",
    };
    expect(resolve(files, "#utils/x")).toMatchObject({
      status: "RESOLVED",
      targetPath: "src/utils/x.ts",
    });
    expect(resolve(files, "#dep")).toMatchObject({
      status: "EXTERNAL",
      externalPackage: "lodash",
    });
    expect(resolve(files, "#nope").status).toBe("UNRESOLVED");
  });

  it("does not resolve URLs or absolute paths", () => {
    expect(resolve({ "src/a.ts": "" }, "https://cdn/x.js").status).toBe(
      "UNRESOLVED",
    );
    expect(resolve({ "src/a.ts": "" }, "/abs/path").status).toBe("UNRESOLVED");
    expect(resolve({ "src/a.ts": "" }, "").status).toBe("UNRESOLVED");
  });

  it("resolves exports maps with patterns and conditions", () => {
    expect(resolveExportsMap({ ".": "./a.js" }, ".", ["import"])).toEqual([
      "./a.js",
    ]);
    expect(
      resolveExportsMap({ import: "./m.js", require: "./c.js" }, ".", [
        "require",
      ]),
    ).toEqual(["./c.js"]);
    expect(
      resolveExportsMap({ "./f/*": "./x/*.js" }, "./f/a/b", ["default"]),
    ).toEqual(["./x/a/b.js"]);
    expect(
      resolveExportsMap({ ".": "./a.js" }, "./other", ["default"]),
    ).toEqual([]);
  });
});

describe("end-to-end dependency records", () => {
  it("preserves specifiers and locations and keeps CommonJS", () => {
    const { records } = analyze(fixtures.commonjs);
    const deps = records.dependencies.filter(
      (d) => d.sourcePath === "lib/app.cjs",
    );
    expect(deps.map((d) => d.specifier)).toEqual([
      "./math",
      "./math.cjs",
      "path",
    ]);
    expect(deps[0]).toMatchObject({
      status: "RESOLVED",
      targetPath: "lib/math.cjs",
      moduleSystem: "CJS",
      kind: "REQUIRE",
    });
    expect(deps[2]).toMatchObject({
      status: "EXTERNAL",
      externalPackage: "node:path",
    });
    expect(deps[0].location.startLine).toBe(1);
  });

  it("retains both edges of a circular import", () => {
    const { records } = analyze(fixtures.circular);
    expect(
      records.dependencies
        .map((d) => `${d.sourcePath}->${d.targetPath}`)
        .sort(),
    ).toEqual(["src/x.ts->src/y.ts", "src/y.ts->src/x.ts"]);
  });

  it("distinguishes type-only imports from runtime imports", () => {
    const { records } = analyze(fixtures.typescript);
    const deps = records.dependencies.filter(
      (d) => d.sourcePath === "src/service.ts",
    );
    expect(deps.map((d) => d.isTypeOnly)).toEqual([true, false]);
  });
});
