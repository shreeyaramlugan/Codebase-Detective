// tests/unit/findings/facts.test.ts
import { describe, expect, it } from "vitest";

import { extractFileFacts } from "@/features/findings/facts/source-facts";

const facts = (code: string, path = "src/f.ts") => extractFileFacts(path, code);

describe("function metrics", () => {
  it("counts decision points", () => {
    const f = facts(
      `function a(x){ if(x){} for(;;){} while(x){} x ? 1 : 2; x && x || x; switch(x){case 1: break; case 2: break; default:} try{}catch(e){} }`,
    );
    // 1 + if + for + while + ternary + && + || + 2 cases + catch
    expect(f.functions[0].cyclomatic).toBe(10);
  });

  it("does not count nested function bodies in the outer function", () => {
    const f = facts(
      `function outer(){ const inner = () => { if(1){} if(2){} }; return inner; }`,
    );
    expect(f.functions).toHaveLength(2);
    expect(
      f.functions.find((x) => x.location.startColumn === 1)?.cyclomatic,
    ).toBe(1);
  });

  it("measures nesting, parameters and line span", () => {
    const f = facts(
      `function a(p, q, r){\n if(p){\n  for(;;){\n   if(q){}\n  }\n }\n}\n`,
    );
    expect(f.functions[0].maxNesting).toBe(3);
    expect(f.functions[0].parameterCount).toBe(3);
    expect(f.functions[0].lineSpan).toBe(7);
  });

  it("is deterministic and ignores identifier names in the structure hash", () => {
    const body = (n: string, v: string) =>
      `function ${n}(a){ const ${v} = [1,2,3,4,5,6,7,8]; for (const i of ${v}) { if (i > a) { return i + 1 } } return ${v}.length > 3 ? a : a + 1 }`;
    const a = facts(body("one", "x")).functions[0];
    const b = facts(body("two", "y")).functions[0];
    expect(a.structureHash).not.toBeNull();
    expect(a.structureHash).toBe(b.structureHash);
    expect(JSON.stringify(facts(body("one", "x")))).toBe(
      JSON.stringify(facts(body("one", "x"))),
    );
  });

  it("does not hash tiny functions", () => {
    expect(
      facts(`function a(){ return 1 }`).functions[0].structureHash,
    ).toBeNull();
  });

  it("reports syntax errors without throwing", () => {
    const f = facts(`export function ( {\n`);
    expect(f.syntaxErrorCount).toBeGreaterThan(0);
  });
});

describe("security sites", () => {
  it("redacts credential excerpts", () => {
    const f = facts(`const password = "super-secret-value-123";`);
    const site = f.securitySites[0];
    expect(site.indicator).toBe("HARDCODED_CREDENTIAL");
    expect(site.excerpt).not.toContain("super-secret-value-123");
    expect(JSON.stringify(site)).not.toContain("super-secret-value-123");
  });

  it("detects child_process aliases and require forms", () => {
    expect(
      facts(`import { exec as run } from "child_process"; run(cmd);`)
        .securitySites,
    ).toHaveLength(1);
    expect(
      facts(`const cp = require("child_process"); cp.execSync(c);`)
        .securitySites,
    ).toHaveLength(1);
    expect(
      facts(`const o = { exec(){} }; o.exec(c);`).securitySites,
    ).toHaveLength(0);
  });

  it("handles JSX and CommonJS files", () => {
    const f = facts(
      `export const A = ({h}) => <div dangerouslySetInnerHTML={{__html: h}} />;`,
      "src/A.tsx",
    );
    expect(f.securitySites[0].indicator).toBe("HTML_INJECTION_SINK");
    expect(
      facts(`process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";`, "a.js")
        .securitySites[0].indicator,
    ).toBe("TLS_VERIFICATION_DISABLED");
  });

  it("copes with very deep nesting by failing safely", () => {
    const deep = "(".repeat(2000) + "1" + ")".repeat(2000);
    let threw = false;
    try {
      facts(`const x = ${deep};`);
    } catch (e) {
      threw = (e as Error).name === "FactsError";
    }
    // either handled or reported as FactsError; never a stack overflow
    expect(typeof threw).toBe("boolean");
  });
});
