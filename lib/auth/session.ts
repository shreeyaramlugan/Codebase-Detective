import "server-only";

import { headers } from "next/headers";
import { auth } from "@/lib/auth";

export async function getCurrentSession() {
  return auth.api.getSession({
    headers: await headers(),
  });
}

export async function requireSession() {
  const session = await getCurrentSession();

  if (!session) {
    throw new Error("UNAUTHORIZED");
  }

  return session;
}
