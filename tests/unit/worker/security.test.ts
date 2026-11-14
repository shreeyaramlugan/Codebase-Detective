// tests/unit/worker/security.test.ts
//
// Static guards for the worker's trust boundaries. These read the source of
// the worker and job modules and fail if code is introduced that would run
// repository content, shell out, or send the signed-in user's email anywhere.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const rel = (f: string) => relative(ROOT, f).split(sep).join("/");
const read = (f: string) => readFileSync(f, "utf8");

const WORKER_FILES = [
  ...walk(join(ROOT, "lib", "worker")),
  ...walk(join(ROOT, "worker")),
  ...walk(join(ROOT, "lib", "jobs")),
].filter((f) => f.endsWith(".ts"));

describe("worker trust boundaries", () => {
  it("finds the files it is meant to guard", () => {
    expect(WORKER_FILES.length).toBeGreaterThan(10);
  });

  it("never executes repository code or spawns processes", () => {
    const banned = /\b(child_process|execSync|execFile|spawnSync|spawn\(|eval\(|new Function\(|vm\.runIn|worker_threads)\b/;
    const offenders = WORKER_FILES.filter((f) => banned.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("never imports repository source dynamically", () => {
    const offenders = WORKER_FILES.filter((f) => /import\(\s*[^"'`\s]/.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("never reads the signed-in user's email", () => {
    const offenders = WORKER_FILES.filter((f) => /user\.email|session\.user\.email|\.email\b/.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("does not log raw errors, payloads or job data directly with console", () => {
    const offenders = WORKER_FILES.filter((f) => /console\.(log|info|debug)\(/.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("job views never expose payloads, lock owners or heartbeat internals", () => {
    const src = read(join(ROOT, "lib", "jobs", "job-admin.ts"));
    const view = src.slice(src.indexOf("export function toJobView"), src.indexOf("export class JobNotFoundError"));
    for (const field of ["payload", "lockedBy", "lockedAt", "heartbeatAt", "requestedById", "dedupeKey"]) {
      expect(view).not.toContain(field);
    }
  });

  it("every admin route is gated by the operator check", () => {
    const adminRoutes = walk(join(ROOT, "app", "api", "admin")).filter((f) => f.endsWith("route.ts"));
    expect(adminRoutes.length).toBeGreaterThanOrEqual(3);
    for (const file of adminRoutes) expect(read(file)).toContain("requireWorkerAdmin(userId)");
  });

  it("job routes resolve the caller from the session, never from the request", () => {
    const routes = [
      ...walk(join(ROOT, "app", "api", "jobs")),
      ...walk(join(ROOT, "app", "api", "admin")),
    ].filter((f) => f.endsWith("route.ts"));
    for (const file of routes) {
      const src = read(file);
      expect(src.includes("requireSession") || src.includes("handleJobRequest")).toBe(true);
      expect(src).not.toMatch(/searchParams\.get\("(userId|ownerId)"\)/);
    }
  });
});
