import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  CantiviaClient,
  CantiviaError,
  DEFAULT_BASE_URL,
  type FetchLike,
  MAX_BATCH_CLAIMS,
  NotFoundError,
  UnprocessableEntityError,
  VERSION,
} from "../src/index";

interface Seen {
  method?: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake API that answers each request with the next reply (repeating the last) and records it. */
function fakeApi(...replies: { status?: number; body: unknown }[]) {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (input, init) => {
    seen.push({
      method: init?.method,
      url: input,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const reply = replies[Math.min(seen.length, replies.length) - 1];
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { c: new CantiviaClient({ apiKey: "ctv_test", baseUrl: "http://gw", fetch, maxRetries: 0 }), seen, fetch };
}

const path = (s: Seen) => new URL(s.url).pathname;

describe("resolve", () => {
  test("posts the follow-up with the prior claims and returns the rewrite", async () => {
    const { c, seen } = fakeApi({ body: { claim: "Ireland's 2019 inflation rate was 0.9%.", resolved: true, method: "model" } });
    const result = await c.resolve("what about 2019?", { priorClaims: ["Ireland's inflation rate was 2.1% in 2024."] });
    expect(seen[0].method).toBe("POST");
    expect(path(seen[0])).toBe("/api/v1/resolve");
    expect(seen[0].body).toEqual({
      followUp: "what about 2019?",
      priorClaims: ["Ireland's inflation rate was 2.1% in 2024."],
    });
    expect(result).toEqual({ claim: "Ireland's 2019 inflation rate was 0.9%.", resolved: true, method: "model" });
  });

  test("sends an empty claim list when none is given", async () => {
    const { c, seen } = fakeApi({ body: { claim: "x", resolved: false, method: "passthrough" } });
    const result = await c.resolve("x");
    expect(seen[0].body).toEqual({ followUp: "x", priorClaims: [] });
    expect(result.resolved).toBe(false);
  });

  test("rejects an empty follow-up and too many prior claims before sending", async () => {
    const { c, seen } = fakeApi({ body: {} });
    await expect(c.resolve("")).rejects.toThrow("invalid resolve request");
    await expect(c.resolve("x", { priorClaims: Array(21).fill("c") })).rejects.toThrow("invalid resolve request");
    expect(seen).toEqual([]);
  });
});

const SCREEN = {
  decision: "review",
  score: 0.83,
  band: 0.01,
  precision: 0.41,
  precisionInterval: [0.33, 0.5],
  evidence: [
    ["term-a", 0.2],
    ["term-b", 0.1],
  ],
  caveats: ["The screen scores writing style, not misconduct."],
  model: { cohort: "cohort-a", trainedThrough: 2024, trainedOn: { "journal-a": 1200 } },
  error: null,
};

describe("screenManuscript", () => {
  test("posts the title, abstract and budget and returns the decision", async () => {
    const { c, seen } = fakeApi({ body: SCREEN });
    const result = await c.screenManuscript({ title: "A title", abstract: "An abstract.", budget: 0.01 });
    expect(path(seen[0])).toBe("/api/v1/paper-mill/screen");
    expect(seen[0].body).toEqual({ title: "A title", abstract: "An abstract.", budget: 0.01 });
    expect(result.decision).toBe("review");
    expect(result.precisionInterval).toEqual([0.33, 0.5]);
    expect(result.evidence[0]).toEqual(["term-a", 0.2]);
  });

  test("an unavailable screen is an answer, not an error", async () => {
    const { c } = fakeApi({
      body: { ...SCREEN, decision: "unavailable", score: null, band: null, precision: null, precisionInterval: null, evidence: [], caveats: [], model: null, error: "The screen is not available." },
    });
    const result = await c.screenManuscript({ abstract: "An abstract." });
    expect(result.decision).toBe("unavailable");
    expect(result.model).toBeNull();
  });

  test("rejects a manuscript with no text, or a budget out of range, before sending", async () => {
    const { c, seen } = fakeApi({ body: SCREEN });
    await expect(c.screenManuscript({ title: "  ", abstract: "" })).rejects.toThrow("a title or an abstract is required");
    await expect(c.screenManuscript({ title: "t", budget: 0 })).rejects.toThrow("invalid manuscript");
    await expect(c.screenManuscript({ title: "t", budget: 1.5 })).rejects.toThrow("invalid manuscript");
    expect(seen).toEqual([]);
  });
});

const BATCH_ID = "0b5c2f9e-6d1a-4c3b-8e7f-9a0b1c2d3e4f";

function batch(status: string, items: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return {
    batch_id: BATCH_ID,
    status,
    total: items.length,
    pending: items.filter((i) => i.status === "pending").length,
    done: items.filter((i) => i.status === "done").length,
    failed: items.filter((i) => i.status === "failed").length,
    created_at: "2026-10-20T10:00:00Z",
    items,
    ...extra,
  };
}

const PENDING = { idx: 0, claim: "The Eiffel Tower is in Berlin.", status: "pending" };
const DONE_ITEM = {
  idx: 0,
  claim: "The Eiffel Tower is in Berlin.",
  status: "done",
  verdict: "fake",
  confidence: 0.97,
  reasoning: "It is in Paris.",
  citations: [{ url: "https://example.org/eiffel", quote: "in Paris" }],
  degraded: false,
  processing_ms: 850,
};
const FAILED_ITEM = { idx: 1, claim: "Water boils at 50 C at sea level.", status: "failed", error: "The check could not be completed." };

describe("batches", () => {
  test("submitBatch posts the claims and normalises the answer", async () => {
    const { c, seen } = fakeApi({ status: 202, body: { batch_id: BATCH_ID, total: 2, status: "queued" } });
    const accepted = await c.submitBatch(["claim one", "claim two"]);
    expect(seen[0].method).toBe("POST");
    expect(path(seen[0])).toBe("/api/v1/batch");
    expect(seen[0].body).toEqual({ claims: ["claim one", "claim two"], kind: "claim" });
    expect(seen[0].headers["Idempotency-Key"]).toBeUndefined();
    expect(accepted).toEqual({ batchId: BATCH_ID, total: 2, status: "queued" });
  });

  test("submitBatch sends kind and the idempotency key", async () => {
    const { c, seen } = fakeApi({ status: 202, body: { batch_id: BATCH_ID, total: 1, status: "queued" } });
    await c.submitBatch(["An article's text."], { kind: "article", idempotencyKey: "order-1234" });
    expect(seen[0].body).toEqual({ claims: ["An article's text."], kind: "article" });
    expect(seen[0].headers["Idempotency-Key"]).toBe("order-1234");
  });

  test("a reused idempotency key maps to UnprocessableEntityError", async () => {
    const { c } = fakeApi({ status: 422, body: { error: { code: "idempotency_key_reused", message: "Use a new key." } } });
    const err = await c.submitBatch(["x"], { idempotencyKey: "k" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityError);
    expect((err as UnprocessableEntityError).code).toBe("idempotency_key_reused");
  });

  test("submitBatch rejects an empty, oversized or blank batch before sending", async () => {
    const { c, seen } = fakeApi({ body: {} });
    await expect(c.submitBatch([])).rejects.toThrow("invalid batch");
    await expect(c.submitBatch(Array(MAX_BATCH_CLAIMS + 1).fill("c"))).rejects.toThrow("invalid batch");
    await expect(c.submitBatch(["ok", "   "])).rejects.toThrow("a claim is empty");
    await expect(c.submitBatch(["x".repeat(10_001)])).rejects.toThrow("exceeds 10000 characters");
    expect(seen).toEqual([]);
  });

  test("getBatch normalises the batch and its items to camelCase", async () => {
    const { c, seen } = fakeApi({
      body: batch("completed", [DONE_ITEM, FAILED_ITEM], { finished_at: "2026-10-20T10:01:00Z" }),
    });
    const result = await c.getBatch(BATCH_ID);
    expect(seen[0].method).toBe("GET");
    expect(path(seen[0])).toBe(`/api/v1/batch/${BATCH_ID}`);
    expect(result.batchId).toBe(BATCH_ID);
    expect(result.createdAt).toBe("2026-10-20T10:00:00Z");
    expect(result.finishedAt).toBe("2026-10-20T10:01:00Z");
    expect(result.done).toBe(1);
    expect(result.items[0]).toMatchObject({ idx: 0, verdict: "fake", processingMs: 850 });
    expect(result.items[0].citations[0].url).toBe("https://example.org/eiffel");
    expect(result.items[1]).toMatchObject({ status: "failed", error: "The check could not be completed.", citations: [] });
  });

  test("an unfinished batch has no finishedAt", async () => {
    const { c } = fakeApi({ body: batch("running", [PENDING]) });
    expect((await c.getBatch(BATCH_ID)).finishedAt).toBeNull();
  });

  test("getBatch rejects a malformed id before sending", async () => {
    for (const bad of ["", "not-a-uuid", `${BATCH_ID}/x`, `../${BATCH_ID}`]) {
      const { c, seen } = fakeApi({ body: {} });
      await expect(c.getBatch(bad)).rejects.toThrow("invalid batch id");
      expect(seen).toEqual([]);
    }
  });

  test("another key's batch maps to NotFoundError", async () => {
    const { c } = fakeApi({ status: 404, body: { error: { code: "not_found", message: "No such batch." } } });
    await expect(c.getBatch(BATCH_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("waitForBatch polls until the batch completes and reports every snapshot", async () => {
    const { c, seen } = fakeApi(
      { body: batch("queued", [PENDING]) },
      { body: batch("running", [PENDING]) },
      { body: batch("completed", [DONE_ITEM], { finished_at: "2026-10-20T10:01:00Z" }) },
    );
    const statuses: string[] = [];
    const result = await c.waitForBatch(BATCH_ID, { pollIntervalMs: 0, onProgress: (b) => statuses.push(b.status) });
    expect(statuses).toEqual(["queued", "running", "completed"]);
    expect(seen).toHaveLength(3);
    expect(result.items[0].verdict).toBe("fake");
  });

  test("waitForBatch gives up after maxWaitMs and names the batch", async () => {
    const { c, seen } = fakeApi({ body: batch("running", [PENDING]) });
    await expect(c.waitForBatch(BATCH_ID, { maxWaitMs: 0 })).rejects.toThrow(BATCH_ID);
    expect(seen).toHaveLength(1);
  });

  test("waitForBatch stops waiting between polls as soon as the signal aborts", async () => {
    const { c, seen } = fakeApi({ body: batch("running", [PENDING]) });
    const controller = new AbortController();
    const started = Date.now();
    const err = await c
      .waitForBatch(BATCH_ID, {
        pollIntervalMs: 60_000,
        signal: controller.signal,
        onProgress: () => controller.abort(new Error("caller gave up")),
      })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe("caller gave up");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen).toHaveLength(1);
  });
});

describe("configuration", () => {
  const saved = { key: process.env.CANTIVIA_API_KEY, url: process.env.CANTIVIA_BASE_URL };
  beforeEach(() => {
    delete process.env.CANTIVIA_API_KEY;
    delete process.env.CANTIVIA_BASE_URL;
  });
  afterEach(() => {
    if (saved.key === undefined) delete process.env.CANTIVIA_API_KEY;
    else process.env.CANTIVIA_API_KEY = saved.key;
    if (saved.url === undefined) delete process.env.CANTIVIA_BASE_URL;
    else process.env.CANTIVIA_BASE_URL = saved.url;
  });

  function recorder() {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetch: FetchLike = async (input, init) => {
      seen.push({ url: input, headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ status: "ok" }), { headers: { "content-type": "application/json" } });
    };
    return { fetch, seen };
  }

  test("reads the key and base URL from the environment", async () => {
    process.env.CANTIVIA_API_KEY = "ctv_from_env";
    process.env.CANTIVIA_BASE_URL = "http://env-gw/";
    const { fetch, seen } = recorder();
    await new CantiviaClient({ fetch }).health();
    expect(seen[0].url).toBe("http://env-gw/health");
    expect(seen[0].headers["Authorization"]).toBe("Bearer ctv_from_env");
  });

  test("options win over the environment", async () => {
    process.env.CANTIVIA_API_KEY = "ctv_from_env";
    process.env.CANTIVIA_BASE_URL = "http://env-gw";
    const { fetch, seen } = recorder();
    await new CantiviaClient({ apiKey: "ctv_option", baseUrl: "http://option-gw", fetch }).health();
    expect(seen[0].url).toBe("http://option-gw/health");
    expect(seen[0].headers["Authorization"]).toBe("Bearer ctv_option");
  });

  test("defaults to the public API", async () => {
    const { fetch, seen } = recorder();
    await new CantiviaClient({ fetch }).health();
    expect(DEFAULT_BASE_URL).toBe("https://api.cantivia.com");
    expect(seen[0].url).toBe("https://api.cantivia.com/health");
  });

  test("health needs no key; every other call names CANTIVIA_API_KEY without sending", async () => {
    const { fetch, seen } = recorder();
    const c = new CantiviaClient({ fetch });
    expect(await c.health()).toEqual({ status: "ok" });
    expect(seen[0].headers["Authorization"]).toBeUndefined();
    const err = await c.usage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CantiviaError);
    expect((err as Error).message).toContain("CANTIVIA_API_KEY");
    expect(seen).toHaveLength(1);
  });

  test("sends the SDK's user agent", async () => {
    const { fetch, seen } = recorder();
    await new CantiviaClient({ apiKey: "ctv_test", fetch }).health();
    expect(seen[0].headers["User-Agent"]).toBe(`cantivia-typescript/${VERSION}`);
  });
});
