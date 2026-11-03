export class JobTransitionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "JOB_NOT_FOUND"
      | "INVALID_TRANSITION"
      | "MAX_ATTEMPTS_REACHED"
      | "JOB_ALREADY_CLAIMED",
  ) {
    super(message);
    this.name = "JobTransitionError";
  }
}
