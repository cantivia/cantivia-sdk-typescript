import { describe, expect, test } from "bun:test";

import {
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  CantiviaClient,
  CantiviaError,
  ConflictError,
  type FetchLike,
  InternalServerError,
  NotFoundError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  RequestTooLargeError,
  ServiceUnavailableError,
  UnprocessableEntityError,
  VerificationError,
} from "../src/index";

function failing(status: number, body: string, headers: Record<string, string> = {}): FetchLike {
  return async () => new Response(body, { status, headers });
}

async function errorFor(status: number, body = '{"error":{"code":"some_code","message":"Something failed."}}', headers = {}) {
  const c = new CantiviaClient({ apiKey: "ctv_test", baseUrl: "http://gw", fetch: failing(status, body, headers), maxRetries: 0 });
  return c.usage().catch((e: unknown) => e);
}

describe("error hierarchy", () => {
  test("each status maps to its class", async () => {
    const cases: [number, Function][] = [
      [400, BadRequestError],
      [401, AuthenticationError],
      [402, PaymentRequiredError],
      [403, PermissionDeniedError],
      [404, NotFoundError],
      [409, ConflictError],
      [413, RequestTooLargeError],
      [422, UnprocessableEntityError],
      [429, RateLimitError],
      [500, InternalServerError],
      [502, InternalServerError],
      [503, ServiceUnavailableError],
      [504, InternalServerError],
    ];
    for (const [status, cls] of cases) {
      const err = await errorFor(status);
      expect(err).toBeInstanceOf(cls);
      expect(err).toBeInstanceOf(APIStatusError);
      expect(err).toBeInstanceOf(APIError);
      expect(err).toBeInstanceOf(CantiviaError);
      expect((err as APIStatusError).status).toBe(status);
    }
  });

  test("an unlisted 4xx is a plain APIStatusError", async () => {
    const err = await errorFor(405);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err).not.toBeInstanceOf(BadRequestError);
    expect((err as APIStatusError).status).toBe(405);
  });

  test("the class name is the error's name", async () => {
    expect(((await errorFor(402)) as Error).name).toBe("PaymentRequiredError");
    expect(new APITimeoutError().name).toBe("APITimeoutError");
    expect(new VerificationError("x").name).toBe("VerificationError");
  });

  test("timeouts are connection errors; verification errors are not API errors", () => {
    expect(new APITimeoutError()).toBeInstanceOf(APIConnectionError);
    expect(new VerificationError("x")).not.toBeInstanceOf(APIError);
    expect(new VerificationError("x")).toBeInstanceOf(CantiviaError);
  });
});

describe("error body", () => {
  test("reads code and message from the API's error envelope", async () => {
    const err = (await errorFor(
      429,
      '{"error":{"code":"monthly_quota_exceeded","message":"The pilot allowance is used up."}}',
    )) as RateLimitError;
    expect(err.code).toBe("monthly_quota_exceeded");
    expect(err.message).toBe("429 monthly_quota_exceeded: The pilot allowance is used up.");
    expect(err.body).toEqual({ error: { code: "monthly_quota_exceeded", message: "The pilot allowance is used up." } });
    expect(err.retryAfter).toBeNull();
  });

  test("carries Retry-After in seconds, from either form", async () => {
    const seconds = (await errorFor(429, "{}", { "retry-after": "12" })) as RateLimitError;
    expect(seconds.retryAfter).toBe(12);
    const date = new Date(Date.now() + 30_000).toUTCString();
    const fromDate = (await errorFor(429, "{}", { "retry-after": date })) as RateLimitError;
    expect(fromDate.retryAfter).toBeGreaterThan(25);
    expect(fromDate.retryAfter).toBeLessThanOrEqual(30);
  });

  test("keeps a body that is not JSON as text", async () => {
    const err = (await errorFor(502, "Bad Gateway")) as InternalServerError;
    expect(err.code).toBeNull();
    expect(err.body).toBe("Bad Gateway");
    expect(err.message).toBe("502: Bad Gateway");
  });

  test("a scope refusal keeps the scope it names in the body", async () => {
    const err = (await errorFor(
      403,
      '{"error":{"code":"insufficient_scope","message":"Missing permission.","required_scope":"titrate"}}',
    )) as PermissionDeniedError;
    expect(err.code).toBe("insufficient_scope");
    expect((err.body as { error: { required_scope: string } }).error.required_scope).toBe("titrate");
  });
});

describe("request id", () => {
  test("a status error carries the request-id header and shows it", async () => {
    const err = (await errorFor(
      429,
      '{"error":{"code":"rate_limited","message":"Slow down."},"request_id":"req_body"}',
      { "request-id": "req_header" },
    )) as RateLimitError;
    // The header wins: every response carries it, error or not.
    expect(err.requestId).toBe("req_header");
    expect(err.message).toBe("429 rate_limited: Slow down. (request id req_header)");
  });

  test("falls back to the body's request_id", async () => {
    const err = (await errorFor(
      401,
      '{"error":{"code":"unauthorized","message":"Invalid API key."},"request_id":"req_abc"}',
    )) as AuthenticationError;
    expect(err.requestId).toBe("req_abc");
    expect(err.message).toBe("401 unauthorized: Invalid API key. (request id req_abc)");
  });

  test("is null, and the message unchanged, when the response has none", async () => {
    const err = (await errorFor(502, "Bad Gateway")) as InternalServerError;
    expect(err.requestId).toBeNull();
    expect(err.message).toBe("502: Bad Gateway");
  });

  test("a mid-stream error carries the stream's request id", async () => {
    const stream: FetchLike = async () =>
      new Response('data: {"type":"error","message":"the check timed out"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream", "request-id": "req_stream" },
      });
    const c = new CantiviaClient({ apiKey: "ctv_test", baseUrl: "http://gw", fetch: stream, maxRetries: 0 });
    const chunks = [];
    for await (const chunk of c.verifyStream("c")) chunks.push(chunk);
    expect(chunks.at(-1)).toEqual({ type: "error", message: "the check timed out", requestId: "req_stream" });

    const err = (await c.verify("c").catch((e: unknown) => e)) as VerificationError;
    expect(err).toBeInstanceOf(VerificationError);
    expect(err.requestId).toBe("req_stream");
    expect(err.message).toBe("the check timed out (request id req_stream)");
  });

  test("a verification error built without one says nothing extra", () => {
    const err = new VerificationError("x");
    expect(err.requestId).toBeNull();
    expect(err.message).toBe("x");
  });
});
