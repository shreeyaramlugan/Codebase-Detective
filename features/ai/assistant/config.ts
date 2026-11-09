// features/ai/assistant/config.ts
//
// Usage and size limits. Values come from the environment but are clamped, so
// a typo can neither disable a limit nor push a request past a safe ceiling.
import type { AssistantLimits } from "./contracts";

export const DEFAULT_LIMITS: AssistantLimits = {
  maxQuestionChars: 2_000,
  maxContextChars: 24_000,
  maxOutputTokens: 1_500,
  requestTimeoutMs: 30_000,
  dailyRequestLimit: 30,
  dailyTokenLimit: 200_000,
};

const BOUNDS: Record<keyof AssistantLimits, [number, number]> = {
  maxQuestionChars: [50, 8_000],
  maxContextChars: [2_000, 100_000],
  maxOutputTokens: [100, 4_000],
  requestTimeoutMs: [2_000, 60_000],
  dailyRequestLimit: [1, 1_000],
  dailyTokenLimit: [1_000, 5_000_000],
};

const ENV_NAMES: Record<keyof AssistantLimits, string> = {
  maxQuestionChars: "AI_MAX_QUESTION_CHARS",
  maxContextChars: "AI_MAX_CONTEXT_CHARS",
  maxOutputTokens: "AI_MAX_OUTPUT_TOKENS",
  requestTimeoutMs: "AI_REQUEST_TIMEOUT_MS",
  dailyRequestLimit: "AI_DAILY_REQUEST_LIMIT",
  dailyTokenLimit: "AI_DAILY_TOKEN_LIMIT",
};

export function resolveLimits(
  env: Record<string, string | undefined> = process.env,
): AssistantLimits {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof AssistantLimits>) {
    const raw = env[ENV_NAMES[key]];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (!Number.isInteger(value)) continue;
    const [min, max] = BOUNDS[key];
    limits[key] = Math.min(max, Math.max(min, value));
  }
  return limits;
}

/** The usage day is a UTC calendar day; it resets at 00:00 UTC. */
export function usageDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function nextResetAt(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
}
