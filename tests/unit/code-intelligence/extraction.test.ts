// tests/unit/code-intelligence/extraction.test.ts
import { describe, expect, it } from "vitest";

import { extractFile } from "@/features/code-intelligence/extraction/extract-file";
import { parseSource } from "@/features/code-intelligence/parser/source-parser";

function extract(path: string, text: string) {
  return extractFile(parseSource(path, text), path);
}

const byName = (file: ReturnType<typeof extract>, name: string) =>
  file.symbols.filter((symbol) => symbol.name === name);

describe("declaration extraction", () => {
  it("extracts functions, async, generators and parameters", () => {
    const file = extract(
      "a.ts",
      `export function plain(a: number, b?: string, ...rest: any[]) {}
export async function load() {}
export function* gen() {}
const arrow = (x = 1) => x;
const fnExpr = function named() {};`,
    );

    const plain = byName(file, "plain")[0];
    expect(plain.kind).toBe("FUNCTION");
    expect(plain.isExported).toBe(true);
    expect(plain.details.parameters).toEqual([
      {
        name: "a",
        optional: false,
        rest: false,
        hasDefault: false,
        type: "number",
      },
      {
        name: "b",
        optional: true,
        rest: false,
        hasDefault: false,
        type: "string",
      },
      {
        name: "rest",
        optional: false,
        rest: true,
        hasDefault: false,
        type: "any[]",
      },
    ]);
    expect(byName(file, "load")[0].details.isAsync).toBe(true);
    expect(byName(file, "gen")[0].details.isGenerator).toBe(true);
    expect(byName(file, "arrow")[0].details.form).toBe("arrow");
    expect(byName(file, "fnExpr")[0].details.form).toBe("function-expression");
  });

  it("extracts classes, constructors, methods and properties", () => {
    const file = extract(
      "a.ts",
      `export class Box<T> extends Base implements Shape {
  size = 1;
  static count: number = 0;
  constructor(private name: string) { super(); }
  open(): void {}
  static make() {}
  get label() { return ""; }
  handler = () => {};
}`,
    );

    const box = byName(file, "Box")[0];
    expect(box.kind).toBe("CLASS");
    expect(box.details.typeParameters).toEqual(["T"]);
    expect(box.details.extends).toEqual(["Base"]);
    expect(box.details.implements).toEqual(["Shape"]);
    expect(
      (box.details.properties as { name: string }[]).map((p) => p.name),
    ).toEqual(["size", "count", "name", "handler"]);

    const methods = file.symbols.filter((s) => s.kind === "METHOD");
    expect(methods.map((m) => m.name).sort()).toEqual([
      "constructor",
      "handler",
      "label",
      "make",
      "open",
    ]);
    expect(methods.every((m) => m.parentKey === box.key)).toBe(true);
    expect(byName(file, "constructor")[0].details.isConstructor).toBe(true);
    expect(byName(file, "make")[0].details.static).toBe(true);
  });

  it("extracts interfaces with optional members, generics and inheritance", () => {
    const file = extract(
      "a.ts",
      `export interface Repo<T> extends Base<T>, Other { id: number; name?: string; find(id: number): T }`,
    );
    const repo = byName(file, "Repo")[0];
    expect(repo.kind).toBe("INTERFACE");
    expect(repo.details.typeParameters).toEqual(["T"]);
    expect(repo.details.extends).toEqual(["Base", "Other"]);
    const members = repo.details.members as {
      name: string;
      optional: boolean;
      kind: string;
    }[];
    expect(members.find((m) => m.name === "name")?.optional).toBe(true);
    expect(members.find((m) => m.name === "find")?.kind).toBe("method");
  });

  it("extracts type aliases with their kind", () => {
    const file = extract(
      "a.ts",
      `type U = "a" | "b"; type I = A & B; type G<T> = { v: T }; export type F = () => void;`,
    );
    expect(byName(file, "U")[0].details.typeKind).toBe("union");
    expect(byName(file, "I")[0].details.typeKind).toBe("intersection");
    expect(byName(file, "G")[0].details.typeKind).toBe("object");
    expect(byName(file, "G")[0].details.typeParameters).toEqual(["T"]);
    expect(byName(file, "F")[0].isExported).toBe(true);
  });

  it("extracts variables including destructuring and annotations", () => {
    const file = extract(
      "a.ts",
      `export const a: number = 1; let b = 2; var c; const { d, e: f } = obj; const [g, h] = arr;`,
    );
    const vars = file.symbols.filter((s) => s.kind === "VARIABLE");
    expect(vars.map((v) => v.name)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "f",
      "g",
      "h",
    ]);
    expect(byName(file, "a")[0].details.annotation).toBe("number");
    expect(byName(file, "a")[0].details.declarationKind).toBe("const");
    expect(byName(file, "b")[0].details.declarationKind).toBe("let");
    expect(byName(file, "c")[0].details.declarationKind).toBe("var");
    expect(byName(file, "d")[0].details.destructured).toBe(true);
  });

  it("extracts enums and their members", () => {
    const file = extract(
      "a.ts",
      `export enum Role { Admin, User = "user" } const enum K { A }`,
    );
    const role = byName(file, "Role")[0];
    expect(role.kind).toBe("ENUM");
    expect(role.details.members).toEqual([
      { name: "Admin", hasInitializer: false },
      { name: "User", hasInitializer: true },
    ]);
    expect(byName(file, "K")[0].details.isConst).toBe(true);
  });
});

describe("imports and exports", () => {
  it("distinguishes import forms", () => {
    const file = extract(
      "a.ts",
      `import def from "m1";
import { a, b as c } from "m2";
import * as ns from "m3";
import "m4";
import type { T } from "m5";
import { type U, v } from "m6";`,
    );
    const dep = (spec: string) =>
      file.dependencies.find((d) => d.specifier === spec)!;

    expect(dep("m1").bindings).toEqual([
      { imported: null, local: "def", kind: "default", isTypeOnly: false },
    ]);
    expect(dep("m2").bindings.map((b) => [b.imported, b.local])).toEqual([
      ["a", "a"],
      ["b", "c"],
    ]);
    expect(dep("m3").bindings[0].kind).toBe("namespace");
    expect(dep("m4").kind).toBe("SIDE_EFFECT_IMPORT");
    expect(dep("m5").isTypeOnly).toBe(true);
    expect(dep("m6").isTypeOnly).toBe(false);
    expect(dep("m6").bindings.find((b) => b.local === "U")?.isTypeOnly).toBe(
      true,
    );
  });

  it("distinguishes named, default, export-all and re-exports", () => {
    const file = extract(
      "a.ts",
      `export const n = 1;
export default function d() {}
const x = 1; export { x as y };
export * from "all";
export * as ns from "nsmod";
export { p as q } from "re";
export type { T } from "types";`,
    );

    expect(byName(file, "n")[0].exportNames).toEqual(["n"]);
    expect(byName(file, "d")[0].isDefaultExport).toBe(true);
    expect(byName(file, "d")[0].exportNames).toEqual(["default"]);
    expect(byName(file, "x")[0].exportNames).toEqual(["y"]);

    const kinds = file.dependencies.map((d) => `${d.kind}:${d.specifier}`);
    expect(kinds).toContain("EXPORT_ALL:all");
    expect(kinds).toContain("RE_EXPORT:nsmod");
    expect(kinds).toContain("RE_EXPORT:re");
    expect(
      file.dependencies.find((d) => d.specifier === "types")?.isTypeOnly,
    ).toBe(true);
    expect(
      file.dependencies.find((d) => d.specifier === "re")?.bindings[0],
    ).toMatchObject({
      imported: "p",
      local: "q",
    });
  });

  it("turns `import {a}; export {a}` into a re-export", () => {
    const file = extract("a.ts", `import { a } from "m"; export { a };`);
    expect(
      file.dependencies.some(
        (d) => d.kind === "RE_EXPORT" && d.specifier === "m",
      ),
    ).toBe(true);
  });

  it("records locations for imports", () => {
    const file = extract("a.ts", `\n  import x from "m";`);
    expect(file.dependencies[0].location).toMatchObject({
      startLine: 2,
      startColumn: 3,
    });
  });

  it("extracts dynamic imports and flags non-literal ones", () => {
    const file = extract("a.ts", `import("./lazy"); import(name);`);
    expect(file.dependencies.map((d) => d.kind)).toEqual(["DYNAMIC_IMPORT"]);
    expect(file.diagnostics.some((d) => d.code === "DYNAMIC_IMPORT")).toBe(
      true,
    );
  });
});

describe("CommonJS extraction", () => {
  it("extracts require forms and their bindings", () => {
    const file = extract(
      "a.js",
      `const m = require("./m");
const { a, b: c } = require("./n");
const p = require("./o").prop;
require("./side");
const dyn = require(name);`,
    );
    const dep = (spec: string) =>
      file.dependencies.find((d) => d.specifier === spec)!;
    expect(dep("./m").bindings[0]).toMatchObject({ local: "m", kind: "whole" });
    expect(dep("./n").bindings.map((b) => [b.imported, b.local])).toEqual([
      ["a", "a"],
      ["b", "c"],
    ]);
    expect(dep("./o").bindings[0]).toMatchObject({
      imported: "prop",
      local: "p",
    });
    expect(dep("./side").bindings).toEqual([]);
    expect(
      file.dependencies.every(
        (d) => d.kind === "REQUIRE" && d.moduleSystem === "CJS",
      ),
    ).toBe(true);
    expect(file.diagnostics.some((d) => d.code === "DYNAMIC_REQUIRE")).toBe(
      true,
    );
    expect(file.moduleSyntax).toBe("COMMONJS");
  });

  it("extracts module.exports and exports.x patterns", () => {
    const file = extract(
      "a.js",
      `function helper() {}
module.exports = { helper, run() {}, other: function () {} };
exports.extra = () => 1;`,
    );
    const exported = file.symbols
      .filter((s) => s.isExported)
      .map((s) => s.exportNames[0]);
    expect(exported.sort()).toEqual(["extra", "helper", "other", "run"]);
  });

  it("treats module.exports = function as a whole-module export", () => {
    const file = extract("a.js", `module.exports = function () {};`);
    expect(file.symbols[0].exportNames).toEqual(["module.exports"]);
  });
});

describe("containment, scoping and anonymous functions", () => {
  it("retains parent-child relationships for nested declarations", () => {
    const file = extract(
      "a.ts",
      `function outer() { function inner() { const deep = 1; } }`,
    );
    const outer = byName(file, "outer")[0];
    const inner = byName(file, "inner")[0];
    const deep = byName(file, "deep")[0];
    expect(outer.parentKey).toBeNull();
    expect(inner.parentKey).toBe(outer.key);
    expect(deep.parentKey).toBe(inner.key);
    expect(deep.qualifiedName).toBe("outer.inner.deep");
  });

  it("does not merge duplicate names in different scopes", () => {
    const file = extract(
      "a.ts",
      `function f() {} function g() { function f() {} }`,
    );
    const fs = byName(file, "f");
    expect(fs).toHaveLength(2);
    expect(new Set(fs.map((s) => s.key)).size).toBe(2);
  });

  it("does not merge duplicate names in the same scope", () => {
    const file = extract("a.ts", `var a = 1; var a = 2;`);
    expect(new Set(byName(file, "a").map((s) => s.key)).size).toBe(2);
  });

  it("handles anonymous functions consistently", () => {
    const file = extract(
      "a.ts",
      `items.map((x) => x); items.filter(function (y) { return y; });`,
    );
    const anon = byName(file, "<anonymous>");
    expect(anon).toHaveLength(2);
    expect(
      anon.every((s) => s.kind === "FUNCTION" && s.details.anonymous === true),
    ).toBe(true);
    expect(anon.every((s) => s.details.lexicallyVisible === false)).toBe(true);
  });

  it("is deterministic for identical inputs", () => {
    const text = `export class A { m() { function n() {} } } export const f = () => {};`;
    expect(JSON.stringify(extract("a.ts", text))).toBe(
      JSON.stringify(extract("a.ts", text)),
    );
  });

  it("preserves source locations", () => {
    const file = extract("a.ts", `\n\nexport function f() {\n}\n`);
    expect(file.symbols[0].location).toEqual({
      startLine: 3,
      startColumn: 1,
      endLine: 4,
      endColumn: 2,
    });
  });

  it("does not present unsupported syntax as a finding", () => {
    const file = extract("a.ts", `export default { a: 1 };`);
    expect(file.symbols).toHaveLength(0);
    expect(
      file.diagnostics.some((d) => d.code === "EXPORT_EXPRESSION_NOT_MODELLED"),
    ).toBe(true);
  });

  it("stops at the AST depth limit with a diagnostic instead of crashing", () => {
    const deep = `const x = ${"(".repeat(450)}1${")".repeat(450)};`;
    const file = extract("a.ts", deep);
    expect(
      file.diagnostics.some((d) => d.code === "AST_DEPTH_LIMIT_EXCEEDED"),
    ).toBe(true);
  });
});
