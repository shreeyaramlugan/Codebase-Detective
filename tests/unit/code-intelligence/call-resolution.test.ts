// tests/unit/code-intelligence/call-resolution.test.ts
import { describe, expect, it } from "vitest";

import {
  analyze,
  type Project,
} from "../../fixtures/code-intelligence/projects";

function calls(project: Project) {
  const { records } = analyze(project);
  const nameOf = (key: string | null) =>
    key
      ? (records.symbols.find((s) => s.key === key)?.qualifiedName ?? "?")
      : null;

  return records.calls.map((call) => ({
    callee: call.calleeText,
    resolution: call.resolution,
    target: nameOf(call.targetKey),
    caller: nameOf(call.callerKey),
    reason: call.reason,
    call,
  }));
}

const find = (list: ReturnType<typeof calls>, callee: string) =>
  list.filter((c) => c.callee === callee);

describe("confirmed calls", () => {
  it("resolves local functions through lexical scope", () => {
    const list = calls({
      "a.ts": `function helper() {} export function main() { helper(); }`,
    });
    expect(find(list, "helper")).toMatchObject([
      { resolution: "CONFIRMED", target: "helper", caller: "main" },
    ]);
  });

  it("prefers the nearest scope for duplicate names", () => {
    const list = calls({
      "a.ts": `function helper() {} function main() { function helper() {} helper(); }`,
    });
    expect(find(list, "helper")[0].target).toBe("main.helper");
  });

  it("resolves named imports across files", () => {
    const list = calls({
      "a.ts": `import { b } from "./b"; b();`,
      "b.ts": `export function b() {}`,
    });
    expect(find(list, "b")).toMatchObject([
      { resolution: "CONFIRMED", target: "b", caller: null },
    ]);
  });

  it("resolves default imports, namespace members and renamed imports", () => {
    const list = calls({
      "a.ts": `import d from "./b"; import * as ns from "./b"; import { x as y } from "./b"; d(); ns.x(); y();`,
      "b.ts": `export default function dflt() {} export function x() {}`,
    });
    expect(find(list, "d")[0]).toMatchObject({
      resolution: "CONFIRMED",
      target: "dflt",
    });
    expect(find(list, "ns.x")[0]).toMatchObject({
      resolution: "CONFIRMED",
      target: "x",
    });
    expect(find(list, "y")[0]).toMatchObject({
      resolution: "CONFIRMED",
      target: "x",
    });
  });

  it("follows re-export chains", () => {
    const list = calls({
      "a.ts": `import { renamed, viaStar } from "./mid"; renamed(); viaStar();`,
      "mid.ts": `export { base as renamed } from "./base"; export * from "./star";`,
      "base.ts": `export function base() {}`,
      "star.ts": `export function viaStar() {}`,
    });
    expect(find(list, "renamed")[0]).toMatchObject({
      resolution: "CONFIRMED",
      target: "base",
    });
    expect(find(list, "viaStar")[0]).toMatchObject({
      resolution: "CONFIRMED",
      target: "viaStar",
    });
  });

  it("does not loop forever on circular re-exports", () => {
    const list = calls({
      "a.ts": `import { x } from "./b"; x();`,
      "b.ts": `export * from "./c";`,
      "c.ts": `export * from "./b";`,
    });
    expect(find(list, "x")[0].resolution).toBe("UNRESOLVED");
  });

  it("resolves CommonJS require calls", () => {
    const list = calls({
      "a.js": `const m = require("./m"); const { run } = require("./m"); const f = require("./f"); m.add(); run(); f();`,
      "m.js": `module.exports = { add() {}, run: function () {} };`,
      "f.js": `module.exports = function () {};`,
    });
    expect(find(list, "m.add")[0]).toMatchObject({
      resolution: "CONFIRMED",
      target: "add",
    });
    expect(find(list, "run")[0]).toMatchObject({
      resolution: "CONFIRMED",
      target: "run",
    });
    expect(find(list, "f")[0]).toMatchObject({
      resolution: "CONFIRMED",
      target: "module.exports",
    });
  });

  it("resolves class static members, new and super", () => {
    const list = calls({
      "a.ts": `class Base { static make() {} run() {} }
class Child extends Base { run() { super.run(); } constructor() { super(); } }
Base.make(); new Child();`,
    });
    expect(find(list, "Base.make")[0]).toMatchObject({
      resolution: "CONFIRMED",
      target: "Base.make",
    });
    expect(find(list, "Child")[0]).toMatchObject({
      resolution: "CONFIRMED",
      target: "Child",
    });
    expect(find(list, "super.run")[0]).toMatchObject({
      resolution: "CONFIRMED",
      target: "Base.run",
    });
    expect(find(list, "super")[0]).toMatchObject({
      resolution: "CONFIRMED",
      target: "Base",
    });
  });

  it("resolves immediately invoked function expressions", () => {
    const list = calls({
      "a.ts": `(function () { inner(); })(); function inner() {}`,
    });
    const iife = list.find((c) => c.call.calleeText.startsWith("(function"))!;
    expect(iife.resolution).toBe("CONFIRMED");
    expect(find(list, "inner")[0].caller).toBe("<anonymous>");
  });

  it("preserves call locations", () => {
    const list = calls({ "a.ts": `function f() {}\n\n  f();` });
    expect(list[0].call.location).toMatchObject({
      startLine: 3,
      startColumn: 3,
    });
  });
});

describe("possible calls", () => {
  it("marks this.method() as possible (dynamic dispatch)", () => {
    const list = calls({
      "a.ts": `class A { go() { this.step(); } step() {} }`,
    });
    expect(find(list, "this.step")[0]).toMatchObject({
      resolution: "POSSIBLE",
      target: "A.step",
    });
  });

  it("marks instance method calls as possible", () => {
    const list = calls({
      "a.ts": `class A { run() {} } const a = new A(); a.run();`,
    });
    expect(find(list, "a.run")[0]).toMatchObject({
      resolution: "POSSIBLE",
      target: "A.run",
    });
  });

  it("marks reassignable function variables as possible", () => {
    const list = calls({
      "a.ts": `let f = () => {}; f(); const g = () => {}; g();`,
    });
    expect(find(list, "f")[0].resolution).toBe("POSSIBLE");
    expect(find(list, "g")[0].resolution).toBe("CONFIRMED");
  });

  it("marks same-named declarations as possible for each candidate", () => {
    const list = calls({ "a.js": `function f() {} function f() {} f();` });
    const results = find(list, "f");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.resolution === "POSSIBLE")).toBe(true);
  });

  it("marks .call/.apply invocations as possible", () => {
    const list = calls({ "a.ts": `function f() {} f.call(null);` });
    expect(find(list, "f.call")[0]).toMatchObject({
      resolution: "POSSIBLE",
      target: "f",
    });
  });

  it("marks default import of a CommonJS module as possible (interop)", () => {
    const list = calls({
      "a.ts": `import f from "./f"; f();`,
      "f.js": `module.exports = function () {};`,
    });
    expect(find(list, "f")[0].resolution).toBe("POSSIBLE");
  });
});

describe("unresolved and dynamic calls", () => {
  it("never confirms dynamic calls", () => {
    const list = calls({
      "a.ts": `function f() {} const o: any = {}; const k = "x";
o[k](); (cond ? f : f)(); f()(); (0, f)();`,
    });
    const dynamic = list.filter(
      (c) => c.callee !== "f" || c.call.calleeText !== "f",
    );
    expect(dynamic.length).toBeGreaterThan(0);
    for (const call of list.filter((c) =>
      c.reason.startsWith("Dynamic call"),
    )) {
      expect(call.resolution).toBe("UNRESOLVED");
      expect(call.target).toBeNull();
    }
    expect(find(list, "o[k]")[0].resolution).toBe("UNRESOLVED");
    expect(find(list, "(cond ? f : f)")[0].resolution).toBe("UNRESOLVED");
  });

  it("keeps calls to parameters, globals and external packages as evidence", () => {
    const list = calls({
      "a.ts": `import x from "lodash"; function f(cb: () => void) { cb(); console.log(1); x(); }`,
    });
    for (const callee of ["cb", "console.log", "x"]) {
      expect(find(list, callee)[0]).toMatchObject({
        resolution: "UNRESOLVED",
        target: null,
      });
    }
    expect(find(list, "cb")[0].reason).toContain("local binding");
    expect(find(list, "x")[0].reason).toContain("external package");
  });

  it("does not resolve through ambiguous or unresolved imports", () => {
    const list = calls({
      "a.ts": `import { f } from "./dup"; import { g } from "./missing"; f(); g();`,
      "dup.ts": `export function f() {}`,
      "dup.js": `export function f() {}`,
    });
    expect(find(list, "f")[0]).toMatchObject({
      resolution: "UNRESOLVED",
      target: null,
    });
    expect(find(list, "g")[0]).toMatchObject({
      resolution: "UNRESOLVED",
      target: null,
    });
  });

  it("does not let shadowing locals resolve to outer functions", () => {
    const list = calls({
      "a.ts": `function f() {} function g(fns: any[]) { for (const f of fns) { f(); } try {} catch (f) { f(); } }`,
    });
    expect(find(list, "f").every((c) => c.resolution === "UNRESOLVED")).toBe(
      true,
    );
  });

  it("treats a call to a variable as unresolved", () => {
    const list = calls({ "a.ts": `const h = make(); h();` });
    expect(find(list, "h")[0].resolution).toBe("UNRESOLVED");
  });
});

describe("relations", () => {
  it("resolves extends and implements and keeps unresolved heritage", () => {
    const { records } = analyze({
      "a.ts": `import { Ext } from "lodash"; interface I {} class Base {} class C extends Base implements I {} class D extends Ext {} class E extends mixin(Base) {}`,
    });
    const rel = (name: string) =>
      records.relations.find((r) => r.targetName === name)!;
    expect(rel("Base")).toMatchObject({ kind: "EXTENDS", status: "RESOLVED" });
    expect(rel("I")).toMatchObject({ kind: "IMPLEMENTS", status: "RESOLVED" });
    expect(rel("Ext")).toMatchObject({ status: "EXTERNAL", targetKey: null });
    expect(rel("mixin(Base)")).toMatchObject({
      status: "UNRESOLVED",
      targetKey: null,
    });
  });

  it("records only resolved type references and counts the rest", () => {
    const { records, stats } = analyze({
      "a.ts": `interface P {} export function f<T>(p: P, t: T): Promise<void> { return null as any; }`,
    });
    const refs = records.relations.filter((r) => r.kind === "REFERENCES");
    expect(refs.map((r) => r.targetName)).toEqual(["P"]);
    // Promise (global) and T (a type parameter) are not repository symbols.
    expect(stats.droppedUnresolvedReferences).toBe(2);
  });
});
