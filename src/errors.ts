/**
 * Errors thrown by the Cantivia client.
 *
 * Every error is a `CantiviaError`. Failures to talk to the API are `APIError`s:
 * either the request never got an answer (`APIConnectionError`, and its subclass
 * `APITimeoutError`), or the API answered with an error status (`APIStatusError`,
 * with one subclass per status a caller is likely to branch on). `VerificationError`
 * is separate: the request succeeded, but the verification stream reported a failure.
 *
 * Both carry `requestId`, the id the API gave the request. Quote it when you contact
 * support: it finds every record of that request.
 */

export class CantiviaError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    // Restore the prototype chain so `instanceof` keeps working even when a
    // consumer's bundler downlevels this below ES2015.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Base class for every failure to get a successful answer from the API. */
export class APIError extends CantiviaError {}

/**
 * The request did not get a response: the connection was refused or reset, the host
 * did not resolve, or the network failed. Thrown after the client's retries are spent.
 */
export class APIConnectionError extends APIError {
  constructor(message = "Connection error.", options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * The request, or a stream, went longer than the client's timeout without data.
 * Never retried: the service may already be working on the request.
 */
export class APITimeoutError extends APIConnectionError {
  constructor(message = "Request timed out.", options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * The API answered with an error status.
 *
 * `code` is the API's stable, machine-readable error code (for example
 * `rate_limited` or `monthly_quota_exceeded`); branch on it rather than on `message`.
 * `retryAfter` is the wait the API asked for, in seconds, or `null` when it gave none.
 * `body` is the parsed JSON error body, or the raw text when it was not JSON.
 * `requestId` is the id the API gave the request (the `request-id` header), or `null`.
 */
export class APIStatusError extends APIError {
  readonly status: number;
  readonly code: string | null;
  readonly retryAfter: number | null;
  readonly body: unknown;
  readonly headers: Headers;
  readonly requestId: string | null;

  constructor(status: number, message: string, details: StatusErrorDetails = {}) {
    super(message);
    this.status = status;
    this.code = details.code ?? null;
    this.retryAfter = details.retryAfter ?? null;
    this.body = details.body;
    this.headers = details.headers ?? new Headers();
    this.requestId = details.requestId ?? null;
  }
}

type StatusErrorDetails = {
  code?: string | null;
  retryAfter?: number | null;
  body?: unknown;
  headers?: Headers;
  requestId?: string | null;
};

/** HTTP 400: the request was malformed or a value was out of range. */
export class BadRequestError extends APIStatusError {}

/** HTTP 401: the API key is missing, unknown, revoked or expired. */
export class AuthenticationError extends APIStatusError {}

/**
 * HTTP 402: the account has no usable plan for this product, for example a pilot
 * that has ended or a subscription that is no longer active.
 */
export class PaymentRequiredError extends APIStatusError {}

/** HTTP 403: the key is valid but lacks the permission this request needs. */
export class PermissionDeniedError extends APIStatusError {}

/** HTTP 404: the path, or the resource it names, does not exist for this account. */
export class NotFoundError extends APIStatusError {}

/** HTTP 409: the request conflicts with the account's current state. */
export class ConflictError extends APIStatusError {}

/** HTTP 413: the request body is larger than the API accepts. */
export class RequestTooLargeError extends APIStatusError {}

/** HTTP 422: the request was well-formed but a value was refused. */
export class UnprocessableEntityError extends APIStatusError {}

/**
 * HTTP 429: a rate limit, or an allowance, is exhausted. A `code` of
 * `monthly_quota_exceeded` will not clear by waiting.
 */
export class RateLimitError extends APIStatusError {}

/** HTTP 5xx: the service failed to handle the request. */
export class InternalServerError extends APIStatusError {}

/** HTTP 503: the service is at capacity and refused the request before doing any work. */
export class ServiceUnavailableError extends InternalServerError {}

/**
 * The verification stream reported an `error` event instead of a result. `requestId`
 * is the id the API gave the stream's request, or `null`.
 */
export class VerificationError extends CantiviaError {
  readonly requestId: string | null;

  constructor(message: string, options: { requestId?: string | null } = {}) {
    super(`${message}${quoted(options.requestId)}`);
    this.requestId = options.requestId ?? null;
  }
}

function quoted(requestId: string | null | undefined): string {
  return requestId ? ` (request id ${requestId})` : "";
}

type StatusErrorClass = new (status: number, message: string, details?: StatusErrorDetails) => APIStatusError;

const STATUS_ERRORS: Record<number, StatusErrorClass> = {
  400: BadRequestError,
  401: AuthenticationError,
  402: PaymentRequiredError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  413: RequestTooLargeError,
  422: UnprocessableEntityError,
  429: RateLimitError,
  503: ServiceUnavailableError,
};

/**
 * Build the error for an error response. The API's error body is
 * `{"error": {"code": ..., "message": ...}}`; anything else is kept as `body` and
 * the message falls back to the status line.
 */
export function makeStatusError(
  status: number,
  rawBody: string,
  headers: Headers,
  retryAfter: number | null,
): APIStatusError {
  let body: unknown = rawBody;
  let code: string | null = null;
  let message: string | null = null;
  let requestId = headers.get("request-id") || null;
  try {
    body = JSON.parse(rawBody);
    const parsed = body as { error?: { code?: unknown; message?: unknown }; request_id?: unknown } | null;
    const error = parsed?.error;
    if (error && typeof error === "object") {
      code = typeof error.code === "string" ? error.code : null;
      message = typeof error.message === "string" ? error.message : null;
    }
    if (!requestId && typeof parsed?.request_id === "string" && parsed.request_id) {
      requestId = parsed.request_id;
    }
  } catch {
    // Not JSON: keep the raw text as the body.
  }
  const detail = message ?? (rawBody.trim() ? rawBody.slice(0, 500) : "no error details");
  const text = `${code ? `${status} ${code}` : status}: ${detail}${quoted(requestId)}`;
  const Cls = STATUS_ERRORS[status] ?? (status >= 500 ? InternalServerError : APIStatusError);
  return new Cls(status, text, { code, retryAfter, body, headers, requestId });
}
