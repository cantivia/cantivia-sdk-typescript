import { describe, expect, test } from "bun:test";

import {
  CantiviaClient,
  VerificationError,
  parseChunk,
  type TitrateChunk,
} from "../src/index";

const POST_URL = "https://bsky.app/profile/council.example/post/3root";

const SCORED = {
  scored: true,
  abstainReason: null,
  detail: null,
  platform: "bluesky",
  postUri: "at://did:plc:rootauthor/app.bsky.feed.post/3root",
  probability: 0.7518,
  isViral: true,
  decisionThreshold: 0.46925350832174473,
  viralThresholdSize: 17,
  horizonHours: 1,
  observedNodes: 16,
  nodesInWindow: 14,
  elapsedHours: 2,
  extrapolated: false,
  sizeRange: { low: 14, high: 25, level: 0.8 },
  model: "titrate",
  artifactSha256: "e095ad9ed5cf00bd17fff081d7c34b7634179e7b2e71132fba78262b89c85522",
  artifactFormatVersion: 6,
};

const ABSTAINED = {
  ...SCORED,
  scored: false,
  abstainReason: "window_open",
  detail: "the 1 h window has not closed yet (0.5 h elapsed)",
  probability: null,
  isViral: null,
  nodesInWindow: null,
};

const DONE = {
  type: "done",
  result: {
    claim: "c",
    verdict: "fake",
    confidence: 0.9,
    reasoning: "r",
    citations: [],
    cacheHit: false,
    route: "route-a",
    processingMs: 10,
  },
};

function sse(...chunks: unknown[]): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
}

function clientFor(body: string, seen: { body?: unknown }): CantiviaClient {
  return new CantiviaClient({
    apiKey: "ctv_test",
    baseUrl: "http://test",
    fetch: async (_url, init) => {
      seen.body = JSON.parse(init?.body as string);
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
}

describe("titrate chunk", () => {
  test("parses a score", () => {
    const chunk = parseChunk(JSON.stringify({ type: "titrate", result: SCORED })) as TitrateChunk;
    expect(chunk.result.isViral).toBe(true);
    expect(chunk.result.viralThresholdSize).toBe(17);
    expect(chunk.result.sizeRange).toEqual({ low: 14, high: 25, level: 0.8 });
  });

  test("an answer without a size range still parses", () => {
    const { sizeRange: _omitted, ...sparse } = SCORED;
    const chunk = parseChunk(JSON.stringify({ type: "titrate", result: sparse })) as TitrateChunk;
    expect(chunk.result.sizeRange).toBeNull();
  });

  test("parses an abstention", () => {
    const chunk = parseChunk(JSON.stringify({ type: "titrate", result: ABSTAINED })) as TitrateChunk;
    expect(chunk.result.scored).toBe(false);
    expect(chunk.result.abstainReason).toBe("window_open");
    expect(chunk.result.probability).toBeNull();
  });

  test("keeps an unknown abstain reason as its raw value", () => {
    // A reason a newer server adds must not fail the parse for this version.
    const chunk = parseChunk(
      JSON.stringify({ type: "titrate", result: { ...ABSTAINED, abstainReason: "bored", platform: "mastodon" } }),
    ) as TitrateChunk;
    expect(chunk.result.abstainReason).toBe("bored");
    expect(chunk.result.platform).toBe("mastodon");
  });
});

describe("scorePost", () => {
  test("returns the answer and sends kind post", async () => {
    const seen: { body?: unknown } = {};
    const result = await clientFor(sse({ type: "titrate", result: SCORED }), seen).scorePost(POST_URL);
    expect(result.isViral).toBe(true);
    expect(seen.body).toEqual({ postUrl: POST_URL, kind: "post" });
  });

  test("throws when the server has it switched off", async () => {
    const seen: { body?: unknown } = {};
    const client = clientFor(sse({ type: "error", message: "Titrate post scoring is not enabled." }), seen);
    await expect(client.scorePost(POST_URL)).rejects.toThrow(VerificationError);
  });

  test("verify forwards the post and still returns the verdict", async () => {
    const seen: { body?: unknown } = {};
    const client = clientFor(sse({ type: "titrate", result: SCORED }, DONE), seen);
    const result = await client.verify("c", { postUrl: POST_URL });
    expect(result.claim).toBe("c");
    expect((seen.body as { postUrl?: string }).postUrl).toBe(POST_URL);
  });
});
