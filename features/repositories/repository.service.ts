import { prisma } from "@/lib/db/prisma";
import { requireSession } from "@/lib/auth/session";

export async function getMyRepositories() {
  const session = await requireSession();

  return prisma.repository.findMany({
    where: {
      ownerId: session.user.id,
    },
    orderBy: {
      createdAt: "desc",
    },
  });
}

export async function getMyRepository(repositoryId: string) {
  const session = await requireSession();

  return prisma.repository.findFirst({
    where: {
      id: repositoryId,
      ownerId: session.user.id,
    },
  });
}
