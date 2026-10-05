/** Field-level validation messages keyed by the wire-format field path, e.g. "contact.phone". */
export type FieldErrors = Record<string, string>;

interface AppErrorOptions {
  fields?: FieldErrors;
  headers?: Record<string, string>;
  cause?: unknown;
}

/**
 * An error that is safe to show to API clients: it carries a stable machine-readable `code`, an
 * HTTP status, and a human message that never contains secrets or personal data.
 * Anything that is NOT an AppError is treated as a bug and reported as a generic 500.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields: FieldErrors | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(code: string, status: number, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.fields = options.fields;
    this.headers = options.headers;
  }
}

export class BadRequestError extends AppError {
  constructor(code: string, message: string) {
    super(code, 400, message);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor() {
    super("payload_too_large", 413, "The request body is too large.");
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor() {
    super("unsupported_media_type", 415, "Send the request as application/json.");
  }
}

export class ForbiddenOriginError extends AppError {
  constructor() {
    super("forbidden_origin", 403, "This origin is not allowed to call this API.");
  }
}

export class ValidationError extends AppError {
  constructor(fields: FieldErrors, message = "Some of the details need attention.") {
    super("validation_failed", 422, message, { fields });
  }
}

export class PostcodeNotFoundError extends AppError {
  constructor() {
    super("postcode_not_found", 422, "We couldn't find that postcode. Check it and try again.", {
      fields: { postcode: "We couldn't find that postcode. Check it and try again." },
    });
  }
}

export class OutOfAreaError extends AppError {
  constructor() {
    super("out_of_area", 422, "We don't cover that area yet.", {
      fields: { postcode: "We don't cover that area yet." },
    });
  }
}

export class ChallengeFailedError extends AppError {
  constructor() {
    super("challenge_failed", 403, "We couldn't verify you're human. Please try again.");
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number) {
    super("rate_limited", 429, "Too many requests. Please wait a moment and try again.", {
      headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
    });
  }
}

export class IdempotencyConflictError extends AppError {
  constructor() {
    super(
      "idempotency_key_reuse",
      409,
      "This request id was already used for a different submission. Reload the page and try again.",
    );
  }
}

export class ConsentOutdatedError extends AppError {
  constructor() {
    super("consent_outdated", 409, "The consent wording has been updated. Reload the page and try again.");
  }
}
