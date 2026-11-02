import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireSession } from "@/lib/auth/session";
import { validateGitHubRepository } from "@/lib/github/github.repository";
import { GitHubApiError } from "@/lib/github/github.errors";
import { GitHubUrlError } from "@/lib/github/github-url";

function handleGitHubError(error: GitHubApiError) {
  switch (error.code) {
    case "NOT_FOUND":
      return NextResponse.json(
        {
          error: "Repository not found or not publicly accessible.",
          code: error.code,
        },
        { status: 404 },
      );

    case "NOT_PUBLIC":
      return NextResponse.json(
        {
          error: "Only public GitHub repositories are supported.",
          code: error.code,
        },
        { status: 403 },
      );

    case "FORBIDDEN":
      return NextResponse.json(
        {
          error: "GitHub denied access to this repository.",
          code: error.code,
        },
        { status: 403 },
      );

    case "RATE_LIMITED": {
      const headers = new Headers();

      if (error.retryAfterSeconds !== undefined) {
        headers.set("Retry-After", String(error.retryAfterSeconds));
      }

      return NextResponse.json(
        {
          error: "GitHub API rate limit reached. Please try again later.",
          code: error.code,
          retryable: true,
          retryAfterSeconds: error.retryAfterSeconds ?? null,
        },
        { status: 429, headers },
      );
    }

    case "TIMEOUT":
    case "NETWORK_ERROR":
    case "UPSTREAM_ERROR":
      return NextResponse.json(
        {
          error: "GitHub is temporarily unavailable. Please try again.",
          code: error.code,
          retryable: error.retryable,
        },
        { status: 503 },
      );

    case "INVALID_RESPONSE":
      return NextResponse.json(
        {
          error: "GitHub returned an unexpected response.",
          code: error.code,
        },
        { status: 502 },
      );

    default:
      console.error("Unhandled GitHub API error:", error);

      return NextResponse.json(
        { error: "Unable to retrieve repository information." },
        { status: 502 },
      );
  }
}

export async function POST(request: Request) {
  try {
    // 1. Authenticate the user.
    const session = await requireSession();

    // 2. Validate the request body.
    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid request body." },
        { status: 400 },
      );
    }

    if (
      typeof body !== "object" ||
      body === null ||
      !("url" in body) ||
      typeof body.url !== "string" ||
      body.url.trim().length === 0
    ) {
      return NextResponse.json(
        { error: "Please provide a valid GitHub repository URL." },
        { status: 400 },
      );
    }

    // 3. Validate the URL and retrieve authoritative GitHub metadata.
    const { metadata } = await validateGitHubRepository(body.url.trim());

    // 4. Check for an existing repository belonging to this user.
    const existingRepository = await prisma.repository.findFirst({
      where: {
        ownerId: session.user.id,
        fullName: metadata.fullName,
      },
    });

    if (existingRepository) {
      return NextResponse.json(
        { error: "You have already added this repository." },
        { status: 409 },
      );
    }

    // 5. Create the repository using verified GitHub metadata.
    const repository = await prisma.repository.create({
      data: {
        ownerId: session.user.id,
        provider: "github",
        githubId: metadata.githubId,
        ownerLogin: metadata.owner,
        name: metadata.name,
        fullName: metadata.fullName,
        htmlUrl: metadata.htmlUrl,
        description: metadata.description,
        visibility: "PUBLIC",
        defaultBranch: metadata.defaultBranch,
        language: metadata.language,
        stars: metadata.stars,
        forks: metadata.forks,
        lastCommitSha: metadata.lastCommitSha,
      },
    });

    // 6. Convert BigInt before JSON serialization.
    return NextResponse.json(
      {
        ...repository,
        githubId: repository.githubId?.toString() ?? null,
      },
      { status: 201 },
    );
  } catch (error) {
    // Authentication failure.
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json(
        { error: "Unauthorized. Please sign in." },
        { status: 401 },
      );
    }

    // Invalid GitHub URL.
    if (error instanceof GitHubUrlError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
        },
        { status: 400 },
      );
    }

    // GitHub API errors.
    if (error instanceof GitHubApiError) {
      return handleGitHubError(error);
    }

    // Handle duplicate submissions that race past the initial lookup.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "You have already added this repository." },
        { status: 409 },
      );
    }

    // Unexpected database or application errors.
    console.error("Repository creation failed:", error);

    return NextResponse.json(
      { error: "An unexpected server error occurred." },
      { status: 500 },
    );
  }
}