import type { ErrorPayload } from "./types.ts";

/** An error that should end the run and be shown to the user as-is. */
export class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AgentError";
  }

  toPayload(): ErrorPayload {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export function toErrorPayload(err: unknown): ErrorPayload {
  if (err instanceof AgentError) return err.toPayload();
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return { code: "timeout", message: "The run timed out. Please try again.", retryable: true };
  }
  return {
    code: "internal",
    message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    retryable: true,
  };
}
