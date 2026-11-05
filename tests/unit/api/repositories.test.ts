import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  validateGitHubRepository: vi.fn(),
  repositoryFindFirst: vi.fn(),
  repositoryCreate: vi.fn(),
  indexingJobCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  requireSession: mocks.requireSession,
}));

vi.mock("@/lib/github/github.repository", () => ({
  validateGitHubRepository: mocks.validateGitHubRepository,
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    repository: {
      findFirst: mocks.repositoryFindFirst,
    },
    $transaction: mocks.transaction,
  },
}));

import { POST } from "@/app/api/repositories/route";

const commitSha = "a".repeat(40);

const mockMetadata = {
  githubId: BigInt(10270250),
  owner: "facebook",
  name: "react",
  fullName: "facebook/react",
  htmlUrl: "https://github.com/facebook/react",
  description: "React library",
  isPublic: true,
  defaultBranch: "main",
  language: "JavaScript",
  stars: 100,
  forks: 20,
  lastCommitSha: commitSha,
};

function createRequest(body: unknown) {
  return new Request("http://localhost:3000/api/repositories", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function createTransaction() {
  return {
    repository: {
      create: mocks.repositoryCreate,
    },
    indexingJob: {
      create: mocks.indexingJobCreate,
    },
  };
}

function createRepository() {
  return {
    id: "repository-123",
    ownerId: "user-123",
    ...mockMetadata,
    provider: "github",
    externalId: null,
    visibility: "PUBLIC",
    status: "QUEUED",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function configureSuccessfulRequest() {
  mocks.requireSession.mockResolvedValue({
    user: {
      id: "user-123",
    },
  });

  mocks.validateGitHubRepository.mockResolvedValue({
    parsed: {
      owner: "facebook",
      name: "react",
      fullName: "facebook/react",
      canonicalUrl: "https://github.com/facebook/react",
    },
    metadata: mockMetadata,
  });

  mocks.repositoryFindFirst.mockResolvedValue(null);

  mocks.repositoryCreate.mockResolvedValue(createRepository());

  mocks.indexingJobCreate.mockResolvedValue({
    id: "job-123",
    repositoryId: "repository-123",
    type: "REPOSITORY_INDEX",
    status: "PENDING",
    targetCommitSha: commitSha,
  });

  mocks.transaction.mockImplementation(async (callback) => {
    return callback(createTransaction());
  });
}

describe("POST /api/repositories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureSuccessfulRequest();
  });

  it("creates a repository and pins the indexing job to the resolved commit SHA", async () => {
    const response = await POST(
      createRequest({
        url: "https://github.com/facebook/react",
      }),
    );

    const body = await response.json();

    expect(response.status).toBe(201);

    expect(mocks.indexingJobCreate).toHaveBeenCalledWith({
      data: {
        repositoryId: "repository-123",
        type: "REPOSITORY_INDEX",
        status: "PENDING",
        targetCommitSha: commitSha,
      },
    });

    expect(body.indexingJob.targetCommitSha).toBe(commitSha);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("preserves a null commit SHA when GitHub metadata has no latest commit", async () => {
    mocks.validateGitHubRepository.mockResolvedValue({
      parsed: {
        owner: "facebook",
        name: "react",
        fullName: "facebook/react",
        canonicalUrl: "https://github.com/facebook/react",
      },
      metadata: {
        ...mockMetadata,
        lastCommitSha: null,
      },
    });

    mocks.indexingJobCreate.mockResolvedValue({
      id: "job-123",
      repositoryId: "repository-123",
      type: "REPOSITORY_INDEX",
      status: "PENDING",
      targetCommitSha: null,
    });

    const response = await POST(
      createRequest({
        url: "https://github.com/facebook/react",
      }),
    );

    expect(response.status).toBe(201);

    expect(mocks.indexingJobCreate).toHaveBeenCalledWith({
      data: {
        repositoryId: "repository-123",
        type: "REPOSITORY_INDEX",
        status: "PENDING",
        targetCommitSha: null,
      },
    });
  });

  it("rejects duplicate repositories with HTTP 409", async () => {
    mocks.repositoryFindFirst.mockResolvedValue({
      id: "existing-repository",
      fullName: "facebook/react",
    });

    const response = await POST(
      createRequest({
        url: "https://github.com/facebook/react",
      }),
    );

    expect(response.status).toBe(409);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests with HTTP 401", async () => {
    mocks.requireSession.mockRejectedValue(new Error("UNAUTHORIZED"));

    const response = await POST(
      createRequest({
        url: "https://github.com/facebook/react",
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.validateGitHubRepository).not.toHaveBeenCalled();
  });

  it("rejects an invalid request body with HTTP 400", async () => {
    const response = await POST(
      createRequest({
        name: "react",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.validateGitHubRepository).not.toHaveBeenCalled();
  });

  it("returns HTTP 500 when indexing job creation fails inside the transaction", async () => {
    mocks.indexingJobCreate.mockRejectedValue(
      new Error("Simulated job creation failure"),
    );

    mocks.transaction.mockImplementation(async (callback) => {
      const tx = createTransaction();

      // Simulate the rollback behaviour of a database transaction.
      const result = await callback(tx);

      return result;
    });

    const response = await POST(
      createRequest({
        url: "https://github.com/facebook/react",
      }),
    );

    expect(response.status).toBe(500);
    expect(mocks.repositoryCreate).toHaveBeenCalledTimes(1);
    expect(mocks.indexingJobCreate).toHaveBeenCalledTimes(1);
  });
  it("returns HTTP 409 when a concurrent duplicate violates the unique constraint", async () => {
    mocks.transaction.mockRejectedValue({
      code: "P2002",
    });

    const response = await POST(
      createRequest({
        url: "https://github.com/facebook/react",
      }),
    );

    expect(response.status).toBe(409);
    expect(mocks.repositoryCreate).not.toHaveBeenCalled();
  });
  it("does not create a repository if the transaction fails", async () => {
    mocks.transaction.mockRejectedValue(
      new Error("Simulated database transaction failure"),
    );

    const response = await POST(
      createRequest({
        url: "https://github.com/facebook/react",
      }),
    );

    expect(response.status).toBe(500);
    expect(mocks.repositoryCreate).not.toHaveBeenCalled();
    expect(mocks.indexingJobCreate).not.toHaveBeenCalled();
  });
});
