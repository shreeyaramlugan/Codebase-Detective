
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "@/lib/db/prisma";

const authSecret = process.env.BETTER_AUTH_SECRET;
const authUrl = process.env.BETTER_AUTH_URL;

if (!authSecret) {
  throw new Error("BETTER_AUTH_SECRET is not configured");
}

if (!authUrl) {
  throw new Error("BETTER_AUTH_URL is not configured");
}

export const auth = betterAuth({
  appName: "Codebase Detective",

  baseURL: authUrl,
  secret: authSecret,

  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  trustedOrigins: [
    "http://localhost:3000",
  ],

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
  },

  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },

  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
  },
});
