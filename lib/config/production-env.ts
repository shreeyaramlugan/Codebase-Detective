// lib/config/production-env.ts
//
// Pure validation of the environment a production deployment needs. Used by
// `npm run check:env` (scripts/check-production-env.ts) so a missing or unsafe
// value is found before deploying, not by a user. It returns problem
// descriptions only and never includes a secret's value.
export type Env = Record<string, string | undefined>;
export type Target = "web" | "worker";

export interface EnvReport {
  errors: string[];
  warnings: string[];
}

const PLACEHOLDER = /^(|your_.*|generate_a_random_secret|changeme|placeholder)$/i;

function missing(env: Env, name: string): boolean {
  return PLACEHOLDER.test((env[name] ?? "").trim());
}

function isHttps(value: string | undefined): boolean {
  try {
    return new URL(value ?? "").protocol === "https:";
  } catch {
    return false;
  }
}

export function validateProductionEnv(env: Env, target: Target): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (missing(env, "DATABASE_URL")) {
    errors.push("DATABASE_URL is required.");
  } else if (!/sslmode=require|sslmode=verify/.test(env.DATABASE_URL ?? "")) {
    warnings.push("DATABASE_URL should include sslmode=require.");
  }

  if (env.SOURCE_STORAGE_PROVIDER !== "s3") {
    if (env.SOURCE_STORAGE_PROVIDER === "local" && env.ALLOW_LOCAL_STORAGE === "true") {
      warnings.push(
        "Local snapshot storage is enabled (ALLOW_LOCAL_STORAGE=true): fine for one machine running both the web app and the worker, not for Vercel or a hosted worker.",
      );
    } else {
      errors.push(
        "SOURCE_STORAGE_PROVIDER must be s3 in production (local disk is not durable and is not shared between the web app and the worker). For a single self-hosted machine, set SOURCE_STORAGE_PROVIDER=local and ALLOW_LOCAL_STORAGE=true.",
      );
    }
  } else {
    for (const name of [
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ]) {
      if (missing(env, name)) errors.push(`${name} is required for s3 storage.`);
    }
    if (env.S3_ENDPOINT && !isHttps(env.S3_ENDPOINT)) {
      errors.push("S3_ENDPOINT must be an https URL.");
    }
  }

  if (env.AI_PROVIDER === "mock" || !env.AI_PROVIDER) {
    warnings.push(
      "AI_PROVIDER is mock: the assistant and research synthesis will not produce grounded answers.",
    );
  } else if (env.AI_PROVIDER === "gemini" && target === "web") {
    if (missing(env, "GEMINI_API_KEY")) errors.push("GEMINI_API_KEY is required for AI_PROVIDER=gemini.");
  }
  if (env.AI_PROVIDER === "gemini" && target === "worker" && missing(env, "GEMINI_API_KEY")) {
    errors.push("GEMINI_API_KEY is required for AI_PROVIDER=gemini.");
  }

  if (!env.GITHUB_TOKEN?.trim()) {
    warnings.push(
      "GITHUB_TOKEN is not set: GitHub allows only 60 unauthenticated requests per hour, which large repositories exceed.",
    );
  }

  if (!env.RESEARCH_CONTACT_EMAIL?.trim()) {
    warnings.push(
      "RESEARCH_CONTACT_EMAIL is not set: Crossref and OpenAlex give better rate limits to identified clients.",
    );
  }

  if (env.BACKGROUND_EXECUTION === "inline") {
    errors.push("BACKGROUND_EXECUTION must be worker in production.");
  }

  if (target === "web") {
    if (missing(env, "BETTER_AUTH_SECRET")) {
      errors.push("BETTER_AUTH_SECRET is required.");
    } else if ((env.BETTER_AUTH_SECRET ?? "").length < 32) {
      errors.push("BETTER_AUTH_SECRET should be at least 32 characters.");
    }
    if (!isHttps(env.BETTER_AUTH_URL)) errors.push("BETTER_AUTH_URL must be the https production URL.");
    if (!isHttps(env.NEXT_PUBLIC_APP_URL)) errors.push("NEXT_PUBLIC_APP_URL must be the https production URL.");
    if (/localhost|127\.0\.0\.1/.test(`${env.BETTER_AUTH_URL ?? ""}${env.NEXT_PUBLIC_APP_URL ?? ""}`)) {
      errors.push("Auth URLs must not point at localhost in production.");
    }
    if (missing(env, "GITHUB_CLIENT_ID") || missing(env, "GITHUB_CLIENT_SECRET")) {
      errors.push("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required for GitHub sign-in.");
    }
  } else {
    const heartbeat = Number(env.WORKER_HEARTBEAT_INTERVAL_MS ?? 15000);
    const stale = Number(env.WORKER_STALE_AFTER_MS ?? 90000);
    if (stale < heartbeat * 3) errors.push("WORKER_STALE_AFTER_MS must be at least 3x WORKER_HEARTBEAT_INTERVAL_MS.");
    if ((env.WORKER_HEALTH_HOST ?? "127.0.0.1") === "127.0.0.1") {
      warnings.push("WORKER_HEALTH_HOST is 127.0.0.1: set 0.0.0.0 if the host's health checker must reach /healthz.");
    }
  }

  return { errors, warnings };
}
