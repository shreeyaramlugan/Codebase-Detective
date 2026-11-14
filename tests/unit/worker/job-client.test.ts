// tests/unit/worker/job-client.test.ts
import { describe, expect, it } from "vitest";

import { describeJobState, JobFailedError, waitForJob, WAIT_TIMED_OUT } from "../../../lib/jobs/job-client";

const view = (state: string, over: Record<string, unknown> = {}) => ({
  id: "j1", type: "CODE_ANALYSIS", label: "Code analysis", state, attempts: 1, maxAttempts: 3,
  errorCode: null, errorMessage: null, nextRetryAt: null, result: null, ...over,
});

function scripted(responses: Array<{ status?: number; job?: unknown } | Error>) {
  let i = 0;
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => ({ job: r.job }) };
  }) as unknown as typeof fetch;
  return { fetchImpl, urls, count: () => i };
}
const noSleep = async () => undefined;

describe("waitForJob", () => {
  it("polls until the job completes and returns its result", async () => {
    const s = scripted([{ job: view("QUEUED") }, { job: view("RUNNING") }, { job: view("COMPLETED", { result: { analysisId: "a1" } }) }]);
    const seen: string[] = [];
    const done = await waitForJob("j1", { fetchImpl: s.fetchImpl, sleep: noSleep, onUpdate: (j) => seen.push(j.state) });
    expect(done.result).toEqual({ analysisId: "a1" });
    expect(seen).toEqual(["QUEUED", "RUNNING", "COMPLETED"]);
    expect(s.urls[0]).toBe("/api/jobs/j1");
  });

  it("keeps waiting through an automatic retry", async () => {
    const s = scripted([{ job: view("RETRY_SCHEDULED") }, { job: view("RUNNING", { attempts: 2 }) }, { job: view("COMPLETED") }]);
    const done = await waitForJob("j1", { fetchImpl: s.fetchImpl, sleep: noSleep });
    expect(done.state).toBe("COMPLETED");
  });

  it("rejects when the job failed for good, with the safe code and message", async () => {
    const s = scripted([{ job: view("FAILED", { errorCode: "GRAPH_VALIDATION_FAILED", errorMessage: "Analysis failed." }) }]);
    let err: JobFailedError | null = null;
    try { await waitForJob("j1", { fetchImpl: s.fetchImpl, sleep: noSleep }); } catch (e) { err = e as JobFailedError; }
    expect(err instanceof JobFailedError).toBe(true);
    expect(err?.code).toBe("GRAPH_VALIDATION_FAILED");
    expect(err?.message).toBe("Analysis failed.");
  });

  it("tolerates a few network errors but not endless ones", async () => {
    const ok = scripted([new Error("net"), new Error("net"), { job: view("COMPLETED") }]);
    expect((await waitForJob("j1", { fetchImpl: ok.fetchImpl, sleep: noSleep })).state).toBe("COMPLETED");
    const bad = scripted([new Error("net")]);
    let code = "";
    try { await waitForJob("j1", { fetchImpl: bad.fetchImpl, sleep: noSleep }); } catch (e) { code = (e as JobFailedError).code ?? ""; }
    expect(code).toBe("NETWORK");
    expect(bad.count()).toBe(5);
  });

  it("stops on 404 (another user's job looks missing)", async () => {
    const s = scripted([{ status: 404 }]);
    let code = "";
    try { await waitForJob("j1", { fetchImpl: s.fetchImpl, sleep: noSleep }); } catch (e) { code = (e as JobFailedError).code ?? ""; }
    expect(code).toBe("NOT_FOUND");
    expect(s.count()).toBe(1);
  });

  it("gives up waiting after the timeout without claiming the job failed", async () => {
    const s = scripted([{ job: view("RUNNING") }]);
    let code = "";
    try { await waitForJob("j1", { fetchImpl: s.fetchImpl, sleep: async () => { await new Promise((r) => setTimeout(r, 5)); }, timeoutMs: 20 }); } catch (e) { code = (e as JobFailedError).code ?? ""; }
    expect(code).toBe(WAIT_TIMED_OUT);
  });

  it("describes states in plain words", () => {
    expect(describeJobState({ state: "QUEUED", attempts: 0, maxAttempts: 3 })).toBe("Waiting for a worker");
    expect(describeJobState({ state: "RUNNING", attempts: 2, maxAttempts: 3 })).toBe("Running (attempt 2 of 3)");
    expect(describeJobState({ state: "RETRY_SCHEDULED", attempts: 1, maxAttempts: 3 })).toBe("Will retry automatically");
  });
});
