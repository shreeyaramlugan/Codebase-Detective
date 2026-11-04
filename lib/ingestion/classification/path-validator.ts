import { INGESTION_LIMITS } from "./ingestion-limits";

export type PathValidationError =
  "UNSAFE_PATH" | "PATH_TOO_LONG" | "PATH_SEGMENT_TOO_LONG";

export interface PathValidationResult {
  valid: boolean;
  normalizedPath: string | null;
  error: PathValidationError | null;
}

const CONTROL_CHARACTER_REGEX = /[\u0000-\u001F\u007F]/;

export function validateRepositoryPath(input: string): PathValidationResult {
  const invalid = (error: PathValidationError): PathValidationResult => ({
    valid: false,
    normalizedPath: null,
    error,
  });

  if (typeof input !== "string" || input.length === 0) {
    return invalid("UNSAFE_PATH");
  }

  if (input.length > INGESTION_LIMITS.MAX_PATH_LENGTH) {
    return invalid("PATH_TOO_LONG");
  }

  // Git repository paths use POSIX separators.
  // Reject Windows separators rather than silently normalizing them.
  if (
    input.startsWith("/") ||
    input.startsWith("\\") ||
    input.includes("\\") ||
    CONTROL_CHARACTER_REGEX.test(input) ||
    /^[a-zA-Z]:/.test(input)
  ) {
    return invalid("UNSAFE_PATH");
  }

  const segments = input.split("/");

  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return invalid("UNSAFE_PATH");
  }

  if (
    segments.some(
      (segment) => segment.length > INGESTION_LIMITS.MAX_PATH_SEGMENT_LENGTH,
    )
  ) {
    return invalid("PATH_SEGMENT_TOO_LONG");
  }

  return {
    valid: true,
    normalizedPath: segments.join("/"),
    error: null,
  };
}
