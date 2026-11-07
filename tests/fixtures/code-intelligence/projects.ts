// tests/fixtures/code-intelligence/projects.ts
//
// In-memory fixture projects for the code intelligence engine. Each fixture is
// a map of repository-relative path -> source text.
import { createHash } from "node:crypto";

import type { EngineSourceFile } from "@/features/code-intelligence/contracts";
import {
  analyzeSnapshotSources,
  type EngineInput,
} from "@/features/code-intelligence/engine/analyze-snapshot";
import { buildGraph } from "@/features/code-intelligence/graph/build-graph";
import { isConfigFilePath } from "@/features/code-intelligence/resolution/project-config";
import { isSupportedSourcePath } from "@/features/code-intelligence/parser/script-kind";

export type Project = Record<string, string>;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sourceFile(path: string, content: string): EngineSourceFile {
  return {
    fileId: `file:${path}`,
    path,
    contentHash: sha256(content),
    sizeBytes: Buffer.byteLength(content),
    content,
  };
}

export function toEngineInput(
  project: Project,
  options: {
    completeness?: string | null;
    unavailable?: EngineInput["unavailable"];
    otherStoredPaths?: string[];
  } = {},
): EngineInput {
  const sources: EngineSourceFile[] = [];
  const configs: EngineSourceFile[] = [];
  const other: string[] = [...(options.otherStoredPaths ?? [])];

  for (const [path, content] of Object.entries(project)) {
    if (isSupportedSourcePath(path)) sources.push(sourceFile(path, content));
    else if (isConfigFilePath(path)) configs.push(sourceFile(path, content));
    else other.push(path);
  }

  return {
    sources,
    configs,
    otherStoredPaths: other,
    unavailable: options.unavailable ?? [],
    snapshotCompleteness:
      options.completeness === undefined ? "COMPLETE" : options.completeness,
  };
}

export function analyze(
  project: Project,
  options: Parameters<typeof toEngineInput>[1] = {},
) {
  return analyzeSnapshotSources(toEngineInput(project, options));
}

export function graphOf(
  project: Project,
  options: Parameters<typeof toEngineInput>[1] = {},
) {
  const { records } = analyze(project, options);
  return buildGraph(records, {
    analysisId: "analysis-1",
    snapshotId: "snapshot-1",
    commitSha: "abc123",
    snapshotCompleteness: "COMPLETE",
    engineVersion: "test",
    parserVersion: "test",
  });
}

export const TSCONFIG_ALIAS = JSON.stringify({
  compilerOptions: {
    baseUrl: ".",
    paths: { "@/*": ["src/*"], "@lib": ["src/lib/index.ts"] },
  },
});

export const fixtures = {
  javascript: {
    "src/index.js": `import { add } from "./math.js";\nexport const total = add(1, 2);\n`,
    "src/math.js": `export function add(a, b) { return a + b; }\n`,
  },
  typescript: {
    "src/types.ts": `export interface User { id: number; name?: string }\nexport type Id = string | number;\nexport enum Role { Admin, User = "user" }\n`,
    "src/service.ts": `import type { User } from "./types";\nimport { Role } from "./types";\nexport class UserService<T extends User = User> {\n  private users: T[] = [];\n  constructor(private readonly role: Role) {}\n  add(user: T): void { this.users.push(user); }\n  static create(): UserService { return new UserService(Role.Admin); }\n}\n`,
  },
  jsx: {
    "src/App.jsx": `import React from "react";\nexport default function App() { return <div className="x">{helper()}</div>; }\nfunction helper() { return "hi"; }\n`,
  },
  tsx: {
    "src/Button.tsx": `import * as React from "react";\ninterface Props { label: string }\nexport const Button = ({ label }: Props) => <button>{label}</button>;\n`,
  },
  relativeImports: {
    "src/a.ts": `import { b } from "./b";\nimport { c } from "./nested";\nimport "./side-effect";\nexport const a = b + c;\n`,
    "src/b.ts": `export const b = 1;\n`,
    "src/nested/index.ts": `export const c = 2;\n`,
    "src/side-effect.ts": `console.log("loaded");\n`,
  },
  aliases: {
    "tsconfig.json": TSCONFIG_ALIAS,
    "src/main.ts": `import { util } from "@/util";\nimport { lib } from "@lib";\nexport const x = util() + lib();\n`,
    "src/util.ts": `export function util() { return 1; }\n`,
    "src/lib/index.ts": `export function lib() { return 2; }\n`,
  },
  commonjs: {
    "lib/math.cjs": `function add(a, b) { return a + b; }\nmodule.exports = { add, sub: function (a, b) { return a - b; } };\nexports.extra = () => 1;\n`,
    "lib/app.cjs": `const math = require("./math");\nconst { add } = require("./math.cjs");\nconst path = require("path");\nmath.sub(2, 1);\nadd(1, 2);\n`,
  },
  circular: {
    "src/x.ts": `import { y } from "./y";\nexport const x = () => y();\n`,
    "src/y.ts": `import { x } from "./x";\nexport const y = () => x();\n`,
  },
  duplicateNames: {
    "src/one.ts": `export function run() { function helper() {} helper(); }\nfunction helper() {}\n`,
    "src/two.ts": `export function run() { function helper() {} helper(); }\n`,
  },
  reexports: {
    "src/base.ts": `export function base() {}\nexport const value = 1;\n`,
    "src/mid.ts": `export { base as renamed } from "./base";\nexport * from "./base";\n`,
    "src/top.ts": `import { renamed, value } from "./mid";\nrenamed();\nexport { renamed as again };\n`,
  },
  invalidSyntax: {
    "src/broken.ts": `export function ( {\n`,
    "src/ok.ts": `export const ok = 1;\n`,
  },
  empty: { "src/empty.ts": "", "src/blank.js": "\n\n" },
} satisfies Record<string, Project>;

/** A large but valid file for limit tests. */
export function largeSource(lines: number): string {
  return Array.from(
    { length: lines },
    (_, i) => `export const v${i} = ${i};`,
  ).join("\n");
}
