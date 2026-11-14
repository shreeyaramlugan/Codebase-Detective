// tests/fixtures/worker/fake-db.ts
//
// A small in-memory stand-in for the parts of the Prisma client the job queue
// uses. It is not a general Prisma fake: it supports exactly the operators the
// queue, lifecycle and enqueue code rely on, and it models the two properties
// the queue's correctness depends on:
//   * updateMany applies its conditional `where` and the write in one
//     synchronous step (like a single SQL UPDATE ... WHERE), and
//   * $transaction runs one transaction at a time and rolls back on throw.
// Every method yields to the event loop first so concurrent callers interleave.
type Row = Record<string, any>;

const OPS = new Set(["equals", "not", "in", "notIn", "lt", "lte", "gt", "gte", "contains"]);

const tv = (v: unknown) => (v instanceof Date ? v.getTime() : v);

function matchValue(value: any, cond: any): boolean {
  if (cond === null || typeof cond !== "object" || cond instanceof Date) return tv(value) === tv(cond);
  const keys = Object.keys(cond);
  if (keys.length > 0 && keys.every((k) => OPS.has(k))) {
    return keys.every((k) => {
      const c = cond[k];
      switch (k) {
        case "equals": return tv(value) === tv(c);
        case "not": return !matchValue(value, c);
        case "in": return (c as unknown[]).map(tv).includes(tv(value));
        case "notIn": return !(c as unknown[]).map(tv).includes(tv(value));
        case "lt": return value !== null && value !== undefined && tv(value) < tv(c);
        case "lte": return value !== null && value !== undefined && tv(value) <= tv(c);
        case "gt": return value !== null && value !== undefined && tv(value) > tv(c);
        case "gte": return value !== null && value !== undefined && tv(value) >= tv(c);
        case "contains": return typeof value === "string" && value.includes(c);
        default: return false;
      }
    });
  }
  // Nested relation filter, evaluated against an embedded object on the row.
  return value !== null && typeof value === "object" && matches(value, cond);
}

export function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND") return (Array.isArray(cond) ? cond : [cond]).every((w: Row) => matches(row, w));
    if (key === "OR") return (cond as Row[]).some((w) => matches(row, w));
    if (key === "NOT") return !(Array.isArray(cond) ? cond : [cond]).some((w: Row) => matches(row, w));
    return matchValue(row[key], cond);
  });
}

function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && !(v instanceof Date) && ("increment" in v || "decrement" in v)) {
      row[k] = (row[k] ?? 0) + ((v as any).increment ?? 0) - ((v as any).decrement ?? 0);
    } else {
      row[k] = v;
    }
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
let counter = 0;

class Table {
  rows: Row[] = [];
  constructor(private readonly defaults: () => Row) {}

  private order(list: Row[], orderBy?: Row | Row[]) {
    const o = (Array.isArray(orderBy) ? orderBy[0] : orderBy) as Row | undefined;
    if (!o) return list;
    const [field, dir] = Object.entries(o)[0] as [string, string];
    return [...list].sort((a, b) => {
      const x = tv(a[field]) as any, y = tv(b[field]) as any;
      const c = x === y ? 0 : x === null || x === undefined ? 1 : y === null || y === undefined ? -1 : x < y ? -1 : 1;
      return dir === "desc" ? -c : c;
    });
  }

  async findMany(args: Row = {}) {
    await tick();
    let list = this.order(this.rows.filter((r) => matches(r, args.where)), args.orderBy);
    if (args.take !== undefined) list = list.slice(0, args.take);
    return list.map((r) => ({ ...r }));
  }
  async findFirst(args: Row = {}) {
    const [row] = await this.findMany({ ...args, take: 1 });
    return row ?? null;
  }
  async findUnique(args: Row) { return this.findFirst(args); }
  async findUniqueOrThrow(args: Row) {
    const row = await this.findFirst(args);
    if (!row) throw new Error("Record not found");
    return row;
  }
  async count(args: Row = {}) {
    await tick();
    return this.rows.filter((r) => matches(r, args.where)).length;
  }
  async create(args: Row) {
    await tick();
    const row = { ...this.defaults(), ...args.data };
    this.rows.push(row);
    return { ...row };
  }
  async update(args: Row) {
    await tick();
    const row = this.rows.find((r) => matches(r, args.where));
    if (!row) throw new Error("Record to update not found");
    applyData(row, args.data);
    row.updatedAt = new Date();
    return { ...row };
  }
  async updateMany(args: Row) {
    await tick();
    // Select and write in one synchronous step: the conditional-update guarantee.
    const hit = this.rows.filter((r) => matches(r, args.where));
    for (const row of hit) {
      applyData(row, args.data);
      row.updatedAt = new Date();
    }
    return { count: hit.length };
  }
  async upsert(args: Row) {
    await tick();
    const row = this.rows.find((r) => matches(r, args.where));
    if (row) {
      applyData(row, args.update);
      return { ...row };
    }
    return this.create({ data: args.create });
  }
}

export interface FakeDb {
  indexingJob: Table;
  repository: Table;
  jobEvent: Table;
  workerInstance: Table;
  repositorySnapshot: Table;
  codeAnalysis: Table;
  findingsRun: Table;
  researchRun: Table;
  $queryRaw: () => Promise<unknown>;
  $transaction<T>(fn: (tx: FakeDb) => Promise<T>, options?: unknown): Promise<T>;
  /** Make the next $queryRaw (database check) fail. */
  failQueries: boolean;
}

export function createFakeDb(): FakeDb {
  const base = () => ({ createdAt: new Date(), updatedAt: new Date() });
  const db: any = {
    indexingJob: new Table(() => ({
      id: `job_${++counter}`,
      type: "REPOSITORY_INDEX",
      status: "PENDING",
      targetCommitSha: null,
      attempts: 0,
      maxAttempts: 3,
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      nextRetryAt: null,
      lockedAt: null,
      lockedBy: null,
      heartbeatAt: null,
      requestedById: null,
      payload: null,
      result: null,
      dedupeKey: null,
      ...base(),
    })),
    repository: new Table(() => ({ id: `repo_${++counter}`, status: "QUEUED", ...base() })),
    jobEvent: new Table(() => ({ id: `ev_${++counter}`, at: new Date() })),
    workerInstance: new Table(() => ({ status: "STARTING", activeJobs: 0, stoppedAt: null })),
    repositorySnapshot: new Table(() => ({ id: `snap_${++counter}`, status: "COMPLETED", ...base() })),
    codeAnalysis: new Table(() => ({ id: `an_${++counter}`, status: "COMPLETED", ...base() })),
    findingsRun: new Table(() => ({ id: `fr_${++counter}`, status: "COMPLETED", ...base() })),
    researchRun: new Table(() => ({ id: `rr_${++counter}`, ...base() })),
    failQueries: false,
  };
  const tables = ["indexingJob", "repository", "jobEvent", "workerInstance", "repositorySnapshot", "codeAnalysis", "findingsRun", "researchRun"];
  db.$queryRaw = async () => {
    if (db.failQueries) throw new Error("database unavailable");
    return [{ ok: 1 }];
  };

  let chain: Promise<unknown> = Promise.resolve();
  db.$transaction = (fn: (tx: FakeDb) => Promise<unknown>) => {
    const run = async () => {
      const snapshot = tables.map((t) => db[t].rows.map((r: Row) => ({ ...r })));
      try {
        return await fn(db);
      } catch (error) {
        tables.forEach((t, i) => (db[t].rows = snapshot[i]));
        throw error;
      }
    };
    const result = chain.then(run, run);
    chain = result.catch(() => undefined);
    return result;
  };
  return db as FakeDb;
}

let shared: FakeDb | null = null;

/**
 * Install the fake as the app's Prisma client (lib/db/prisma reads
 * globalThis.prisma once, at first import). The same object is reused for the
 * whole test file and emptied on every call, so each test starts clean.
 */
export function installFakeDb(_unused?: FakeDb): FakeDb {
  if (!shared) {
    shared = createFakeDb();
    (globalThis as any).prisma = shared;
  }
  for (const key of Object.keys(shared)) {
    const value = (shared as any)[key];
    if (value instanceof Table) value.rows = [];
  }
  shared.failQueries = false;
  return shared;
}

export function seedRepository(db: FakeDb, over: Row = {}) {
  const row = { id: `repo_${++counter}`, ownerId: "user_1", status: "QUEUED", ...over };
  db.repository.rows.push({ createdAt: new Date(), updatedAt: new Date(), ...row });
  return row;
}

export function seedJob(db: FakeDb, over: Row = {}) {
  const row = {
    id: `job_${++counter}`,
    repositoryId: "repo_1",
    type: "REPOSITORY_INDEX",
    status: "PENDING",
    targetCommitSha: null,
    attempts: 0,
    maxAttempts: 3,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    nextRetryAt: null,
    lockedAt: null,
    lockedBy: null,
    heartbeatAt: null,
    requestedById: null,
    payload: null,
    result: null,
    dedupeKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  db.indexingJob.rows.push(row);
  return row;
}
