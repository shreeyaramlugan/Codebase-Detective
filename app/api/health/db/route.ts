import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;

    return NextResponse.json({ database: "connected" });
  } catch {
    return NextResponse.json(
      { database: "unavailable" },
      { status: 503 },
    );
  }
}