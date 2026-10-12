// API errors: every error response has the shape
//   { "error": { "code": "JOB_NOT_FOUND", "message": "...", "details"?: ..., "requestId": "..." } }
// Stack traces and internal messages are never sent to clients.

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const E = {
  badRequest: (message: string, details?: unknown) => new AppError(400, "BAD_REQUEST", message, details),
  validation: (message: string, details?: unknown) => new AppError(400, "VALIDATION_FAILED", message, details),
  config: (details: unknown) => new AppError(422, "INVALID_PROJECT_CONFIG", "verifycloud.yaml is invalid", details),
  unauthenticated: () => new AppError(401, "UNAUTHENTICATED", "authentication required"),
  forbidden: (message = "insufficient permissions") => new AppError(403, "FORBIDDEN", message),
  // "not found" is also returned when the caller has no access: resources of
  // other tenants are indistinguishable from nonexistent ones.
  notFound: (what: string) => new AppError(404, `${what.toUpperCase().replace(/[^A-Z]+/g, "_")}_NOT_FOUND`, `${what} does not exist`),
  conflict: (code: string, message: string) => new AppError(409, code, message),
  tooLarge: (message: string) => new AppError(413, "PAYLOAD_TOO_LARGE", message),
  rateLimited: (retryAfter: number) => new AppError(429, "RATE_LIMITED", `too many requests; retry in ${retryAfter}s`, { retryAfter }),
  quota: (message: string, details?: unknown) => new AppError(429, "QUOTA_EXCEEDED", message, details),
  unavailable: (message: string) => new AppError(503, "SERVICE_UNAVAILABLE", message),
  demo: () => new AppError(403, "DEMO_MODE_RESTRICTED", "this action is disabled in the public demo"),
};
