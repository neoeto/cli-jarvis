export type CjErrorCode =
  | "CONFIG_INVALID"
  | "AUTH_MISSING"
  | "PROVIDER_UNAVAILABLE"
  | "MODEL_RESPONSE_INVALID"
  | "TOOL_NOT_FOUND"
  | "TOOL_INPUT_INVALID"
  | "PATH_NOT_AUTHORIZED"
  | "SENSITIVE_DATA_BLOCKED"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_REJECTED"
  | "TOOL_FAILED"
  | "LIMIT_EXCEEDED"
  | "ABORTED";

export class CjError extends Error {
  constructor(
    readonly code: CjErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CjError";
  }
}

export function asCjError(error: unknown): CjError {
  if (error instanceof CjError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new CjError("ABORTED", "Task aborted", { cause: error });
  }
  return new CjError(
    "TOOL_FAILED",
    error instanceof Error ? error.message : String(error),
    { cause: error }
  );
}
