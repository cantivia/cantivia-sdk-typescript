/**
 * Retry policy.
 *
 * Only a request that provably never reached the service is retried: a connection
 * that could not be opened, or an HTTP 429 or 503, which the API sends before
 * starting any work. Everything else (a timeout, a reset, any other 5xx, any 4xx, or
 * a stream that has started) could mean the service is already working on the
 * request, and retrying it would run and bill the work twice.
 */

import { APIConnectionError, APITimeoutError } from "./errors.js";

export const DEFAULT_MAX_RETRIES = 2;

const INITIAL_DELAY_S = 0.5;
const MAX_DELAY_S = 8;
// A longer Retry-After than this is not worth blocking the caller for; the
// exponential backoff applies instead.
const MAX_RETRY_AFTER_S = 60;

/**
 * Parse a `Retry-After` header into seconds. Accepts both forms the HTTP spec allows:
 * a number of seconds, or an HTTP date. Returns `null` when absent or unreadable.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return null;
  }
  return Math.max(0, (date - now) / 1000);
}

/** Whether a response status means the API refused the request before doing any work. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

// Error codes that mean no connection was made, so the request was never sent:
// refused, DNS failure, connect timeout, no socket. Node puts the code on the fetch
// error's `cause`, Bun on the error itself. A reset or a closed socket can come after
// the request was written, so it is not retried, and neither is a failure that does
// not say why, as in browsers and Deno.
const NEVER_CONNECTED_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "ConnectionRefused",
  "FailedToOpenSocket",
]);

function neverConnected(err: unknown): boolean {
  let current = err;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NEVER_CONNECTED_CODES.has(code)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Whether an error thrown while sending means the request never reached the
 * service: an `APIConnectionError` whose cause says the connection was never made.
 */
export function isRetryableError(err: unknown): boolean {
  return err instanceof APIConnectionError && !(err instanceof APITimeoutError) && neverConnected(err.cause);
}

/**
 * How long to wait before retry number `attempt` (0 for the first retry), in
 * milliseconds. A `Retry-After` of up to 60 s is honoured as given. Otherwise the
 * wait doubles from 0.5 s up to 8 s, with equal jitter: half of it fixed and half
 * random, so clients that failed together do not all come back together.
 */
export function retryDelayMs(
  attempt: number,
  retryAfterS: number | null,
  random: () => number = Math.random,
): number {
  if (retryAfterS !== null && retryAfterS >= 0 && retryAfterS <= MAX_RETRY_AFTER_S) {
    return retryAfterS * 1000;
  }
  const delay = Math.min(INITIAL_DELAY_S * 2 ** attempt, MAX_DELAY_S);
  return (delay / 2 + random() * (delay / 2)) * 1000;
}

export interface RetryOptions {
  maxRetries: number;
  /** Cuts a wait between attempts short; the next `send` then sees it aborted. */
  signal?: AbortSignal;
  /** Waits between attempts; replaceable in tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Call `send` until it returns a response that is not a 429 or 503, or the retries
 * are spent. `send` throws `APIConnectionError` when the request got no response
 * (retried only when the connection was never made) and `APITimeoutError` on a
 * timeout (never retried). The last response is returned whatever its status, so
 * the caller turns it into the right error.
 */
export async function withRetries(
  send: () => Promise<Response>,
  options: RetryOptions,
): Promise<Response> {
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < options.maxRetries;
    let response: Response;
    try {
      response = await send();
    } catch (err) {
      if (canRetry && isRetryableError(err)) {
        await sleep(retryDelayMs(attempt, null, options.random), options.signal);
        continue;
      }
      throw err;
    }
    if (canRetry && isRetryableStatus(response.status)) {
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      // Release the connection; the refusal body is not needed.
      await response.body?.cancel().catch(() => undefined);
      await sleep(retryDelayMs(attempt, retryAfter, options.random), options.signal);
      continue;
    }
    return response;
  }
}
