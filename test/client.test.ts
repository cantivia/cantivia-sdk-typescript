import { describe, expect, test } from "bun:test";

import {
  AuthenticationError,
  CantiviaClient,
  CantiviaError,
  type FetchLike,
  InternalServerError,
  MAX_CLAIM_CHARS,
  NotFoundError,
  PermissionDeniedError,
  parseUsage,
  RateLimitError,
  VerificationError,
} from "../src/index";

const USAGE_JSON = {
  key_id: "abc123",
  requests: { window: 3, today: 42, month: 1200 },
  rate_limit: { limit: 100, remaining: 97, window_seconds: 60 },
  verdicts: { true: 10, fake: 5 },
  latency_ms: { p50: 820.0, p95: 1400.0, samples: 200 },
};

const VERIFY_SSE =
  'data: {"type":"routing","action":"route-a","difficulty":0.7}\n\n' +
  'data: {"type":"factcheck_complete","verdict":"fake","confidence":0.97}\n\n' +
  'data: {"type":"done","result":{"claim":"The Eiffel Tower is in Berlin.",' +
  '"verdict":"fake","confidence":0.97,"reasoning":"It is in Paris.",' +
  '"citations":[{"url":"https://en.wikipedia.org/wiki/Eiffel_Tower","quote":"in Paris"}],' +
  '"cacheHit":false,"route":"route-a","processingMs":850}}\n\n';

const ERROR_SSE = 'data: {"type":"error","message":"verification timed out"}\n\n';

// Image path: ocr_complete -> claims_extracted -> claim_verified -> article_done.
const CLAIM_RESULT =
  '{"claim":"Vaccines cause autism","verdict":"fake","confidence":0.96,' +
  '"reasoning":"No credible evidence.","citations":[],' +
  '"cacheHit":false,"route":"route-a","processingMs":900}';
const IMAGE_SSE =
  'data: {"type":"ocr_complete","textChars":21,"language":"en"}\n\n' +
  'data: {"type":"claims_extracted","count":1,"method":"heuristic","claims":[' +
  '{"claim":"Vaccines cause autism","checkWorthiness":0.9,"claimType":"causal",' +
  '"originalText":"Vaccines cause autism","entities":[],"verifiable":true}]}\n\n' +
  `data: {"type":"claim_verified","index":0,"total":1,"result":${CLAIM_RESULT}}\n\n` +
  'data: {"type":"article_done","result":{"claimCount":1,"verifiedCount":1,"degradedCount":0,"overallVerdict":"fake",' +
  '"overallConfidence":0.9,"summary":"One false claim.","extractionMethod":"heuristic",' +
  `"claims":[${CLAIM_RESULT}],"processingMs":1200}}\n\n`;
const OCR_UNAVAILABLE_SSE = 'data: {"type":"error","message":"Text extraction from the image failed."}\n\n';

const TINY_IMAGE_B64 = "iVBORw0KGgo="; // non-empty payload; not decoded client-side

// Forensics-only image path: no OCR, no fact-check.
const MEDIA_ONLY_SSE =
  'data: {"type":"media_forensics","modality":"image","result":{"verdict":"unknown","method":"none",' +
  '"combinedP":null,"channels":[],"excised":[],"alpha":0.01,' +
  '"unavailable":[{"channel":"retrieval","reason":"nothing enrolled"}]}}\n\n' +
  'data: {"type":"media_done","modality":"image"}\n\n';

// Article path: the image path without the OCR hop.
const ARTICLE_SSE =
  'data: {"type":"claims_extracted","count":1,"method":"model","claims":[' +
  '{"claim":"Vaccines cause autism","checkWorthiness":0.9,"claimType":"causal",' +
  '"originalText":"Vaccines cause autism","entities":[],"verifiable":true}]}\n\n' +
  `data: {"type":"claim_verified","index":0,"total":1,"result":${CLAIM_RESULT}}\n\n` +
  'data: {"type":"article_done","result":{"claimCount":1,"verifiedCount":1,"degradedCount":0,"overallVerdict":"fake",' +
  '"overallConfidence":0.9,"summary":"One false claim.","extractionMethod":"model",' +
  `"claims":[${CLAIM_RESULT}],"processingMs":4200}}\n\n`;

const ARTICLE_TEXT = "RTE reported that vaccines cause autism. Health officials disagreed.";

const JSON_HEADERS = { "content-type": "application/json" };

interface HandlerOpts {
  verifyBody?: string;
  status?: number;
  errorHeaders?: Record<string, string>;
  onRequest?: (input: string, init?: RequestInit) => void;
}

function makeFetch(opts: HandlerOpts = {}): FetchLike {
  const { verifyBody = VERIFY_SSE, status = 200, errorHeaders } = opts;
  return async (input, init) => {
    opts.onRequest?.(input, init);
    const path = new URL(input).pathname;
    if (path === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), { headers: JSON_HEADERS });
    }
    if (path === "/api/v1/usage") {
      if (status >= 400) return errorResponse(status, errorHeaders);
      return new Response(JSON.stringify(USAGE_JSON), { headers: JSON_HEADERS });
    }
    if (path === "/api/v1/verify") {
      if (status >= 400) return errorResponse(status, errorHeaders);
      return new Response(verifyBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code: "denied", message: "denied" } }), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

// Retries are covered in retry.test.ts; here every refusal surfaces at once.
function client(opts: HandlerOpts = {}, apiKey = "ctv_test"): CantiviaClient {
  return new CantiviaClient({ apiKey, baseUrl: "http://gw", fetch: makeFetch(opts), maxRetries: 0 });
}

describe("verify", () => {
  test("returns the final result", async () => {
    const result = await client().verify("The Eiffel Tower is in Berlin.");
    expect(result.verdict).toBe("fake");
    expect(result.confidence).toBe(0.97);
    expect(result.cacheHit).toBe(false);
    expect(result.processingMs).toBe(850);
    expect(result.citations[0].url).toBe("https://en.wikipedia.org/wiki/Eiffel_Tower");
  });

  test("verifyStream yields typed chunks in order", async () => {
    const types: string[] = [];
    for await (const chunk of client().verifyStream("x")) {
      types.push(chunk.type);
    }
    expect(types).toEqual(["routing", "factcheck_complete", "done"]);
  });

  test("raises VerificationError on an error chunk", async () => {
    const err = await client({ verifyBody: ERROR_SSE }).verify("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerificationError);
    expect((err as Error).message).toBe("verification timed out");
  });

  test("skips event types it does not know, in the stream and in verify", async () => {
    // Event types this version does not know, as a newer API might send them.
    const verifyBody =
      'data: {"type":"event_from_a_newer_api","detail":"x"}\n\n' + VERIFY_SSE + 'data: {"type":"another_new_event"}\n\n';
    const types: string[] = [];
    for await (const chunk of client({ verifyBody }).verifyStream("x")) {
      types.push(chunk.type);
    }
    expect(types).toEqual(["routing", "factcheck_complete", "done"]);
    const result = await client({ verifyBody }).verify("x");
    expect(result.verdict).toBe("fake");
  });
});

describe("verifyImage", () => {
  test("returns the aggregate article result", async () => {
    const result = await client({ verifyBody: IMAGE_SSE }).verifyImage(TINY_IMAGE_B64);
    expect(result.overallVerdict).toBe("fake");
    expect(result.claimCount).toBe(1);
    expect(result.claims[0].verdict).toBe("fake");
    expect(result.processingMs).toBe(1200);
  });

  test("verifyImageStream starts with ocr_complete then article chunks", async () => {
    const types: string[] = [];
    let textChars: number | undefined;
    for await (const chunk of client({ verifyBody: IMAGE_SSE }).verifyImageStream(TINY_IMAGE_B64)) {
      types.push(chunk.type);
      if (chunk.type === "ocr_complete") textChars = chunk.textChars;
    }
    expect(types).toEqual(["ocr_complete", "claims_extracted", "claim_verified", "article_done"]);
    expect(textChars).toBe(21);
  });

  test("raises VerificationError when the image text cannot be read", async () => {
    await expect(
      client({ verifyBody: OCR_UNAVAILABLE_SSE }).verifyImage(TINY_IMAGE_B64),
    ).rejects.toThrow("Text extraction from the image failed.");
  });

  test("rejects an empty image before sending", async () => {
    await expect(client({ verifyBody: IMAGE_SSE }).verifyImage("")).rejects.toThrow(
      "invalid image verification request",
    );
  });

  test("sends kind=image in the request body", async () => {
    let body: unknown;
    const c = new CantiviaClient({
      apiKey: "ctv_test",
      baseUrl: "http://gw",
      fetch: makeFetch({
        verifyBody: IMAGE_SSE,
        onRequest: (_input, init) => {
          body = JSON.parse(init?.body as string);
        },
      }),
    });
    await c.verifyImage(TINY_IMAGE_B64);
    expect((body as { kind: string }).kind).toBe("image");
    expect((body as { image: string }).image).toBe(TINY_IMAGE_B64);
    // Absent unless asked for, so the server's default (the full image path) applies.
    expect((body as { forensicsOnly?: boolean }).forensicsOnly).toBeUndefined();
  });

  test("forensicsOnly is sent, and the stream ends at media_done", async () => {
    let body: Record<string, unknown> = {};
    const c = new CantiviaClient({
      apiKey: "ctv_test",
      baseUrl: "http://gw",
      fetch: makeFetch({
        verifyBody: MEDIA_ONLY_SSE,
        onRequest: (_input, init) => {
          body = JSON.parse(init?.body as string);
        },
      }),
    });
    const types: string[] = [];
    for await (const chunk of c.verifyImageStream(TINY_IMAGE_B64, { forensicsOnly: true })) {
      types.push(chunk.type);
    }
    expect(body).toMatchObject({ kind: "image", forensicsOnly: true });
    expect(types).toEqual(["media_forensics", "media_done"]);
  });

  test("verifyMedia on an image asks for forensics only and returns the result", async () => {
    let body: Record<string, unknown> = {};
    const c = new CantiviaClient({
      apiKey: "ctv_test",
      baseUrl: "http://gw",
      fetch: makeFetch({
        verifyBody: MEDIA_ONLY_SSE,
        onRequest: (_input, init) => {
          body = JSON.parse(init?.body as string);
        },
      }),
    });
    const result = await c.verifyMedia(TINY_IMAGE_B64, "image");
    expect(body).toMatchObject({ kind: "image", image: TINY_IMAGE_B64, forensicsOnly: true });
    expect(result.unavailable[0].channel).toBe("retrieval");
  });
});

describe("verifyArticle", () => {
  test("returns the aggregate document result", async () => {
    const result = await client({ verifyBody: ARTICLE_SSE }).verifyArticle(ARTICLE_TEXT);
    expect(result.overallVerdict).toBe("fake");
    expect(result.claimCount).toBe(1);
    expect(result.processingMs).toBe(4200);
  });

  test("verifyArticleStream has no OCR hop", async () => {
    const types: string[] = [];
    for await (const chunk of client({ verifyBody: ARTICLE_SSE }).verifyArticleStream(ARTICLE_TEXT)) {
      types.push(chunk.type);
    }
    expect(types).toEqual(["claims_extracted", "claim_verified", "article_done"]);
  });

  test("sends kind=article in the request body", async () => {
    // The whole point of the request schema: without `kind` the server runs
    // single-claim mode over the article text.
    let body: unknown;
    const c = new CantiviaClient({
      apiKey: "ctv_test",
      baseUrl: "http://gw",
      fetch: makeFetch({
        verifyBody: ARTICLE_SSE,
        onRequest: (_input, init) => {
          body = JSON.parse(init?.body as string);
        },
      }),
    });
    await c.verifyArticle(ARTICLE_TEXT);
    expect((body as { kind: string }).kind).toBe("article");
    expect((body as { claim: string }).claim).toBe(ARTICLE_TEXT);
  });

  test("verify() sends no kind, so the server default applies", async () => {
    let body: unknown;
    const c = new CantiviaClient({
      apiKey: "ctv_test",
      baseUrl: "http://gw",
      fetch: makeFetch({
        onRequest: (_input, init) => {
          body = JSON.parse(init?.body as string);
        },
      }),
    });
    await c.verify("x");
    expect(body as Record<string, unknown>).not.toHaveProperty("kind");
  });

  test("rejects empty article text before sending", async () => {
    await expect(client({ verifyBody: ARTICLE_SSE }).verifyArticle("")).rejects.toThrow(
      "invalid article verification request",
    );
  });

  test("accepts a body up to the server cap, rejects past it", async () => {
    // Regression: the client capped `claim` at 10k while the server allows 50k,
    // so article bodies the server would have taken were rejected here.
    const atCap = "x".repeat(MAX_CLAIM_CHARS);
    const result = await client({ verifyBody: ARTICLE_SSE }).verifyArticle(atCap);
    expect(result.claimCount).toBe(1);

    await expect(
      client({ verifyBody: ARTICLE_SSE }).verifyArticle("x".repeat(MAX_CLAIM_CHARS + 1)),
    ).rejects.toThrow("invalid article verification request");
  });
});

describe("http", () => {
  test("sends the bearer auth header", async () => {
    let auth: string | undefined;
    const c = new CantiviaClient({
      apiKey: "ctv_test",
      baseUrl: "http://gw",
      fetch: makeFetch({
        onRequest: (_input, init) => {
          auth = (init?.headers as Record<string, string>)?.["Authorization"];
        },
      }),
    });
    await c.usage();
    expect(auth).toBe("Bearer ctv_test");
  });

  test("health returns the parsed body", async () => {
    expect(await client().health()).toEqual({ status: "ok" });
  });

  test("maps 401 to AuthenticationError", async () => {
    await expect(client({ status: 401 }).verify("x")).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("maps 403 to PermissionDeniedError", async () => {
    await expect(client({ status: 403 }).verify("x")).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  test("maps 429 to RateLimitError", async () => {
    await expect(client({ status: 429 }).verify("x")).rejects.toBeInstanceOf(RateLimitError);
  });

  test("maps 500 to InternalServerError with the API's error code", async () => {
    try {
      await client({ status: 500 }).verify("x");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InternalServerError);
      expect((err as InternalServerError).status).toBe(500);
      expect((err as InternalServerError).code).toBe("denied");
    }
  });

  test("parses Retry-After into retryAfter seconds", async () => {
    try {
      await client({ status: 429, errorHeaders: { "Retry-After": "12" } }).usage();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfter).toBe(12);
    }
  });

  test("retryAfter is null when the header is absent", async () => {
    try {
      await client({ status: 429 }).usage();
      throw new Error("expected throw");
    } catch (err) {
      expect((err as RateLimitError).retryAfter).toBeNull();
    }
  });
});

describe("usage", () => {
  test("normalises the snake_case wire payload to camelCase", async () => {
    const usage = await client().usage();
    expect(usage.keyId).toBe("abc123");
    expect(usage.requests.month).toBe(1200);
    expect(usage.rateLimit.remaining).toBe(97);
    expect(usage.rateLimit.windowSeconds).toBe(60);
    expect(usage.verdicts).toEqual({ true: 10, fake: 5 });
    expect(usage.latencyMs.p95).toBe(1400.0);
    expect(usage.latencyMs.samples).toBe(200);
  });

  test("carries per-product entitlements, and reads a report without them as none", () => {
    const usage = parseUsage({
      ...USAGE_JSON,
      products: [
        {
          product: "praetorian",
          status: "active",
          tier: "growth",
          pilot_ends_at: null,
          units: [
            { unit: "media_check", used: 260000, allowance: 250000, overage: 10000 },
            { unit: "catalogue_item", used: 12, allowance: 25000, overage: 0 },
          ],
        },
      ],
    });
    expect(usage.products[0].pilotEndsAt).toBeNull();
    expect(usage.products[0].units[0].overage).toBe(10000);
    expect(parseUsage(USAGE_JSON).products).toEqual([]);
  });
});

const ASSET_ID = "a".repeat(64);

const CATALOGUE_LIST_JSON = {
  assets: [
    {
      assetId: ASSET_ID,
      name: "press-photo.jpg",
      modality: "image",
      enrolledAt: "2026-09-28T10:00:00Z",
      source: "api",
      bytesLen: 48213,
    },
  ],
  gallerySize: 1,
  maxAssets: 198,
};

/**
 * A catalogue gateway that answers each request with the next reply (repeating the
 * last) and records each request's method, path and body.
 */
function catalogueClient(...replies: { status?: number; body: unknown }[]) {
  const seen: { method?: string; path: string; body: unknown }[] = [];
  const fetch: FetchLike = async (input, init) => {
    seen.push({ method: init?.method, path: new URL(input).pathname, body: init?.body });
    const reply = replies[Math.min(seen.length, replies.length) - 1];
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: JSON_HEADERS,
    });
  };
  return { c: new CantiviaClient({ apiKey: "ctv_test", baseUrl: "http://gw", fetch }), seen };
}

describe("catalogue", () => {
  test("listCatalogue GETs the assets with no body and parses them", async () => {
    const { c, seen } = catalogueClient({ body: CATALOGUE_LIST_JSON });
    const listing = await c.listCatalogue();
    expect(seen).toEqual([{ method: "GET", path: "/api/v1/catalogue/assets", body: undefined }]);
    expect(listing.assets[0].assetId).toBe(ASSET_ID);
    expect(listing.assets[0].bytesLen).toBe(48213);
    expect(listing.gallerySize).toBe(1);
    expect(listing.maxAssets).toBe(198);
  });

  test("listCatalogue rejects a payload that is not a listing", async () => {
    const { c } = catalogueClient({ body: { assets: [] } });
    await expect(c.listCatalogue()).rejects.toThrow("unexpected catalogue listing payload");
  });

  test("deleteCatalogueAsset DELETEs the asset by id", async () => {
    const { c, seen } = catalogueClient({
      body: { deleted: true, assetId: ASSET_ID, gallerySize: 0, maxAssets: 198 },
    });
    const erased = await c.deleteCatalogueAsset(ASSET_ID);
    expect(seen).toEqual([
      { method: "DELETE", path: `/api/v1/catalogue/assets/${ASSET_ID}`, body: undefined },
    ]);
    expect(erased).toEqual({ deleted: true, assetId: ASSET_ID, gallerySize: 0, maxAssets: 198 });
  });

  test("deleteCatalogueAsset rejects a malformed id before sending", async () => {
    // The id becomes part of the URL, so anything but 64 lowercase hex never leaves.
    for (const bad of ["", "a".repeat(63), "A".repeat(64), `../${"a".repeat(61)}`, `${"a".repeat(64)}/x`]) {
      const { c, seen } = catalogueClient({ body: {} });
      const err = await c.deleteCatalogueAsset(bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CantiviaError);
      expect((err as Error).message).toContain("invalid catalogue asset id");
      expect(seen).toEqual([]);
    }
  });

  test("an asset the catalogue does not hold maps to NotFoundError", async () => {
    const { c } = catalogueClient({ status: 404, body: { error: { code: "not_found", message: "not held" } } });
    try {
      await c.deleteCatalogueAsset(ASSET_ID);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).status).toBe(404);
      expect((err as NotFoundError).code).toBe("not_found");
    }
  });
});

const JOB_ID = "3f2b8c1e-4a5d-4e6f-9a7b-1c2d3e4f5a6b";
const JOB_PATH = `/api/v1/catalogue/jobs/${JOB_ID}`;

function enrollJob(status: string, assetStatus: string, extra: Record<string, unknown> = {}) {
  return {
    jobId: JOB_ID,
    status,
    total: 1,
    completed: assetStatus === "pending" ? 0 : 1,
    assets: [{ name: "press-photo.jpg", assetId: ASSET_ID, status: assetStatus, reason: null }],
    gallerySize: null,
    maxAssets: null,
    receipts: [],
    error: null,
    ...extra,
  };
}

const QUEUED = { status: 202, body: enrollJob("queued", "pending") };
const RUNNING = { body: enrollJob("running", "pending") };
const DONE = {
  body: enrollJob("done", "enrolled", { gallerySize: 1, maxAssets: 198, receipts: [{ assetId: ASSET_ID }] }),
};
const ASSETS = [{ name: "press-photo.jpg", media: TINY_IMAGE_B64 }];

describe("catalogue enrolment", () => {
  test("enrollMedia submits, polls the job until done, and reports every snapshot", async () => {
    const { c, seen } = catalogueClient(QUEUED, RUNNING, DONE);
    const statuses: string[] = [];
    const job = await c.enrollMedia(ASSETS, { pollIntervalMs: 0, onProgress: (j) => statuses.push(j.status) });
    expect(statuses).toEqual(["queued", "running", "done"]);
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/v1/catalogue/assets",
      `GET ${JOB_PATH}`,
      `GET ${JOB_PATH}`,
    ]);
    expect(JSON.parse(seen[0].body as string)).toEqual({ assets: ASSETS, source: "api" });
    expect(job.assets[0].status).toBe("enrolled");
    expect(job.gallerySize).toBe(1);
    expect(job.receipts).toHaveLength(1);
  });

  test("enrollMedia returns a failed job rather than throwing", async () => {
    const failed = { body: enrollJob("failed", "failed", { error: "not decodable" }) };
    const { c } = catalogueClient(QUEUED, failed);
    const job = await c.enrollMedia(ASSETS, { pollIntervalMs: 0 });
    expect(job.status).toBe("failed");
    expect(job.error).toBe("not decodable");
  });

  test("enrollMedia gives up after maxWaitMs and names the job to read on", async () => {
    const { c, seen } = catalogueClient(QUEUED, RUNNING);
    await expect(c.enrollMedia(ASSETS, { maxWaitMs: 0 })).rejects.toThrow(JOB_ID);
    expect(seen).toHaveLength(1);
  });

  test("enrollMedia stops waiting between polls as soon as the signal aborts", async () => {
    const { c, seen } = catalogueClient(QUEUED, RUNNING);
    const controller = new AbortController();
    const started = Date.now();
    const err = await c
      .enrollMedia(ASSETS, {
        pollIntervalMs: 60_000,
        signal: controller.signal,
        onProgress: () => controller.abort(new Error("caller gave up")),
      })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe("caller gave up");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen).toHaveLength(1);
  });

  test("startEnrollment returns the 202 job without waiting", async () => {
    const { c, seen } = catalogueClient(QUEUED, DONE);
    const job = await c.startEnrollment(ASSETS, { source: "archive" });
    expect(job.status).toBe("queued");
    expect(job.assets[0].assetId).toBe(ASSET_ID);
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0].body as string).source).toBe("archive");
  });

  test("getEnrollmentJob reads the job by id", async () => {
    const { c, seen } = catalogueClient(DONE);
    const job = await c.getEnrollmentJob(JOB_ID);
    expect(seen).toEqual([{ method: "GET", path: JOB_PATH, body: undefined }]);
    expect(job.status).toBe("done");
  });

  test("getEnrollmentJob rejects a malformed id before sending", async () => {
    for (const bad of ["", "not-a-uuid", JOB_ID.replaceAll("-", ""), `${JOB_ID}/x`, `../${JOB_ID}`]) {
      const { c, seen } = catalogueClient(DONE);
      await expect(c.getEnrollmentJob(bad)).rejects.toThrow("invalid enrolment job id");
      expect(seen).toEqual([]);
    }
  });

  test("an expired job maps to NotFoundError", async () => {
    const { c } = catalogueClient({ status: 404, body: { error: { code: "not_found", message: "gone" } } });
    const err = await c.getEnrollmentJob(JOB_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).status).toBe(404);
  });
});
