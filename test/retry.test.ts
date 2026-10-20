import { describe, expect, test } from "bun:test";

import {
  APIConnectionError,
  APITimeoutError,
  CantiviaClient,
  type FetchLike,
  InternalServerError,
  RateLimitError,
  ServiceUnavailableError,
} from "../src/index";
import { parseRetryAfter, retryDelayMs, withRetries } from "../src/retry";

const USAGE_JSON = {
  key_id: "abc123",
  requests: { window: 1, today: 1, month: 1 },
  rate_limit: { limit: 100, remaining: 99, window_seconds: 60 },
  verdicts: {},
  latency_ms: { p50: 1, p95: 1, samples: 1 },
};

const ok = () => new Response(JSON.stringify(USAGE_JSON), { headers: { "content-type": "application/json" } });

function refusal(status: number, retryAfter: string | null = "0"): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (retryAfter !== null) headers["retry-after"] = retryAfter;
  return new Response(JSON.stringify({ error: { code: "overloaded", message: "busy" } }), { status, headers });
}

/** A transport that plays `steps` in order (a Response, or an error to throw) and counts calls. */
function scripted(...steps: (Response | Error | (() => Response))[]) {
  let calls = 0;
  const fetch: FetchLike = async () => {
    const step = steps[Math.min(calls, steps.length - 1)];
    calls++;
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step() : step.clone();
  };
  return { fetch, calls: () => calls };
}

const noSleep = { sleep: async () => {} };

/** A fetch failure as a runtime reports it: Node puts the code on `cause`, Bun on the error. */
function nodeFetchError(code: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code}`), { code }) });
}
function bunFetchError(code: string): TypeError {
  return Object.assign(new TypeError("Unable to connect."), { code });
}
const connectionError = (cause: unknown) => new APIConnectionError("Connection error.", { cause });

describe("parseRetryAfter", () => {
  test("reads seconds", () => {
    expect(parseRetryAfter("12")).toBe(12);
    expect(parseRetryAfter(" 1.5 ")).toBe(1.5);
  });

  test("reads an HTTP date relative to now", () => {
    const now = Date.parse("Tue, 20 Oct 2026 10:00:00 GMT");
    expect(parseRetryAfter("Tue, 20 Oct 2026 10:00:07 GMT", now)).toBe(7);
    expect(parseRetryAfter("Tue, 20 Oct 2026 09:59:00 GMT", now)).toBe(0);
  });

  test("is null when absent or unreadable", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("retryDelayMs", () => {
  test("doubles from 0.5 s with equal jitter, capped at 8 s", () => {
    expect(retryDelayMs(0, null, () => 0)).toBe(250);
    expect(retryDelayMs(0, null, () => 1)).toBe(500);
    expect(retryDelayMs(1, null, () => 0)).toBe(500);
    expect(retryDelayMs(1, null, () => 1)).toBe(1000);
    expect(retryDelayMs(10, null, () => 0)).toBe(4000);
    expect(retryDelayMs(10, null, () => 1)).toBe(8000);
  });

  test("honours a Retry-After of up to 60 s", () => {
    expect(retryDelayMs(0, 5, () => 0)).toBe(5000);
    expect(retryDelayMs(3, 60, () => 0)).toBe(60_000);
  });

  test("ignores a Retry-After over 60 s and backs off instead", () => {
    expect(retryDelayMs(0, 61, () => 1)).toBe(500);
  });
});

describe("withRetries", () => {
  test("retries 429 and 503 up to maxRetries, then returns the last response", async () => {
    const t = scripted(refusal(429), refusal(503), refusal(429));
    const send = () => t.fetch("http://x");
    const response = await withRetries(send, { maxRetries: 2, ...noSleep });
    expect(t.calls()).toBe(3);
    expect(response.status).toBe(429);
  });

  test("stops as soon as a response is not a refusal", async () => {
    const t = scripted(refusal(503), ok());
    const response = await withRetries(() => t.fetch("http://x"), { maxRetries: 2, ...noSleep });
    expect(t.calls()).toBe(2);
    expect(response.status).toBe(200);
  });

  test("retries a connection that was never made, and rethrows it once retries are spent", async () => {
    const refused = connectionError(nodeFetchError("ECONNREFUSED"));
    const t = scripted(refused, connectionError(bunFetchError("ENOTFOUND")), refused);
    await expect(withRetries(() => t.fetch("http://x"), { maxRetries: 2, ...noSleep })).rejects.toBeInstanceOf(
      APIConnectionError,
    );
    expect(t.calls()).toBe(3);
  });

  test("never retries a connection error that may have come after the request was sent", async () => {
    const ambiguous = [nodeFetchError("ECONNRESET"), bunFetchError("ConnectionClosed"), new TypeError("Failed to fetch")];
    for (const cause of ambiguous) {
      const t = scripted(connectionError(cause), ok());
      await expect(withRetries(() => t.fetch("http://x"), { maxRetries: 2, ...noSleep })).rejects.toBeInstanceOf(
        APIConnectionError,
      );
      expect(t.calls()).toBe(1);
    }
  });

  test("never retries a timeout", async () => {
    const t = scripted(new APITimeoutError(), ok());
    await expect(withRetries(() => t.fetch("http://x"), { maxRetries: 2, ...noSleep })).rejects.toBeInstanceOf(
      APITimeoutError,
    );
    expect(t.calls()).toBe(1);
  });

  test("never retries 500, 502 or 504", async () => {
    for (const status of [500, 502, 504]) {
      const t = scripted(refusal(status), ok());
      const response = await withRetries(() => t.fetch("http://x"), { maxRetries: 2, ...noSleep });
      expect(response.status).toBe(status);
      expect(t.calls()).toBe(1);
    }
  });

  test("maxRetries 0 disables retrying", async () => {
    const t = scripted(refusal(503), ok());
    const response = await withRetries(() => t.fetch("http://x"), { maxRetries: 0, ...noSleep });
    expect(response.status).toBe(503);
    expect(t.calls()).toBe(1);
  });

  test("waits what Retry-After asks, and backs off without it", async () => {
    const waits: number[] = [];
    const t = scripted(refusal(429, "3"), refusal(503, null), ok());
    await withRetries(() => t.fetch("http://x"), {
      maxRetries: 2,
      random: () => 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits).toEqual([3000, 500]);
  });
});

describe("client retries", () => {
  function client(fetch: FetchLike, maxRetries?: number) {
    return new CantiviaClient({ apiKey: "ctv_test", baseUrl: "http://gw", fetch, maxRetries });
  }

  test("retries a 503 twice by default, then throws ServiceUnavailableError", async () => {
    const t = scripted(refusal(503));
    const err = await client(t.fetch).usage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err).toBeInstanceOf(InternalServerError);
    expect((err as ServiceUnavailableError).retryAfter).toBe(0);
    expect(t.calls()).toBe(3);
  });

  test("a 429 that clears is retried transparently", async () => {
    const t = scripted(refusal(429), ok());
    const usage = await client(t.fetch).usage();
    expect(usage.keyId).toBe("abc123");
    expect(t.calls()).toBe(2);
  });

  test("maxRetries is settable per call", async () => {
    const t = scripted(refusal(429));
    const err = await client(t.fetch).usage({ maxRetries: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(t.calls()).toBe(1);
  });

  test("does not retry a 500", async () => {
    const t = scripted(refusal(500), ok());
    await expect(client(t.fetch).usage()).rejects.toBeInstanceOf(InternalServerError);
    expect(t.calls()).toBe(1);
  });

  test("retries a connection that was never made, and wraps the failure", async () => {
    for (const refused of [nodeFetchError("ECONNREFUSED"), bunFetchError("ConnectionRefused")]) {
      const t = scripted(refused, ok());
      const usage = await client(t.fetch, 1).usage();
      expect(usage.keyId).toBe("abc123");
      expect(t.calls()).toBe(2);
    }

    const down = scripted(nodeFetchError("ENOTFOUND"));
    const err = await client(down.fetch, 0).usage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect((err as APIConnectionError).cause).toBeInstanceOf(TypeError);
  });

  test("does not retry a reset, which can come after the request was written", async () => {
    const t = scripted(nodeFetchError("ECONNRESET"), ok());
    const err = await client(t.fetch).usage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(t.calls()).toBe(1);
  });

  test("never retries a stream that has started", async () => {
    // A verify stream that dies mid-body: the check may already be running.
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ === 0) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"routing","action":"a","difficulty":0.1}\n\n'));
          } else {
            controller.error(new TypeError("connection reset"));
          }
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    const types: string[] = [];
    const err = await (async () => {
      for await (const chunk of client(fetch).verifyStream("x")) types.push(chunk.type);
    })().catch((e: unknown) => e);
    expect(types).toEqual(["routing"]);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err).not.toBeInstanceOf(APITimeoutError);
    expect(calls).toBe(1);
  });
});

/** A transport that never answers until the request is aborted. */
function hanging() {
  let calls = 0;
  const fetch: FetchLike = (_input, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  };
  return { fetch, calls: () => calls };
}

describe("timeouts", () => {
  test("throws APITimeoutError and does not retry", async () => {
    const t = hanging();
    const c = new CantiviaClient({ apiKey: "ctv_test", baseUrl: "http://gw", fetch: t.fetch, timeoutMs: 20 });
    const err = await c.usage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APITimeoutError);
    expect(t.calls()).toBe(1);
  });

  test("timeoutMs is settable per call", async () => {
    const t = hanging();
    const c = new CantiviaClient({ apiKey: "ctv_test", baseUrl: "http://gw", fetch: t.fetch });
    await expect(c.usage({ timeoutMs: 20 })).rejects.toBeInstanceOf(APITimeoutError);
  });

  test("a stream that keeps sending data does not time out", async () => {
    // Five events 30 ms apart under a 100 ms idle timeout: 150 ms in all.
    const fetch: FetchLike = async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 0; i < 4; i++) {
            await new Promise((r) => setTimeout(r, 30));
            controller.enqueue(encoder.encode('data: {"type":"factcheck_thinking","delta":"..."}\n\n'));
          }
          await new Promise((r) => setTimeout(r, 30));
          controller.enqueue(
            encoder.encode(
              'data: {"type":"done","result":{"claim":"x","verdict":"true","confidence":0.9,"reasoning":"r",' +
                '"citations":[],"cacheHit":false,"route":"route-a","processingMs":60}}\n\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    const c = new CantiviaClient({ apiKey: "ctv_test", baseUrl: "http://gw", fetch, timeoutMs: 100 });
    const result = await c.verify("x");
    expect(result.verdict).toBe("true");
  });

  test("a caller's abort rejects with the caller's reason, not a timeout", async () => {
    const t = hanging();
    const c = new CantiviaClient({ apiKey: "ctv_test", baseUrl: "http://gw", fetch: t.fetch });
    const controller = new AbortController();
    const pending = c.usage({ signal: controller.signal }).catch((e: unknown) => e);
    controller.abort(new Error("caller gave up"));
    const err = await pending;
    expect(err).not.toBeInstanceOf(APITimeoutError);
    expect((err as Error).message).toBe("caller gave up");
    expect(t.calls()).toBe(1);
  });
});
