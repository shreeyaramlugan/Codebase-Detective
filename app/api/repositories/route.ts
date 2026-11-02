import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireSession } from "@/lib/auth/session";

export async function POST(request: Request) {
  try {
    // 1. Verify the user is signed in
    const session = await requireSession();

    // 2. Read the repository details
    const body = await request.json();

    // 3. Create the repository under the signed-in user
    const repository = await prisma.repository.create({
      data: {
        ownerId: session.user.id,
        provider: "github",
        ownerLogin: body.ownerLogin,
        name: body.name,
        fullName: body.fullName,
        htmlUrl: body.htmlUrl,
        defaultBranch: body.defaultBranch ?? null,
      },
    });

    return NextResponse.json(repository, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json(
        { error: "Unauthorized. Please sign in." },
        { status: 401 },
      );
    }

    console.error("Repository creation failed:", error);

    return NextResponse.json(
      { error: "Failed to create repository." },
      { status: 500 },
    );
  }
}
