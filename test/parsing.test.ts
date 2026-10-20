import { describe, expect, test } from "bun:test";

import { CantiviaError } from "../src/errors";
import {
  ArticleDoneChunk,
  BatchSchema,
  CacheResultChunk,
  CatalogueEnrollJobSchema,
  ClaimsExtractedChunk,
  DebateArgumentChunk,
  DebateDecomposedChunk,
  DebateRoundChunk,
  DoneChunk,
  FactcheckCompleteChunk,
  FactcheckThinkingChunk,
  MediaDoneChunk,
  MediaForensicsChunk,
  OcrCompleteChunk,
  RoutingChunk,
  SearchCompleteChunk,
  VERDICT_LABELS,
  parseChunk,
} from "../src/models";

describe("parseChunk", () => {
  test("parses each chunk type", () => {
    const routing = parseChunk('{"type":"routing","action":"route-a","difficulty":0.7}') as RoutingChunk;
    expect(routing.type).toBe("routing");
    expect(routing.action).toBe("route-a");

    const fc = parseChunk('{"type":"factcheck_complete","verdict":"fake","confidence":0.91}') as FactcheckCompleteChunk;
    expect(fc.verdict).toBe("fake");

    const done = parseChunk(
      '{"type":"done","result":{"claim":"x","verdict":"fake","confidence":0.91,' +
        '"reasoning":"because","citations":[{"url":"https://e.com","quote":"q"}],' +
        '"cacheHit":false,"route":"route-a","processingMs":1234}}',
    ) as DoneChunk;
    expect(done.result.cacheHit).toBe(false);
    expect(done.result.processingMs).toBe(1234);
    expect(done.result.citations[0].url).toBe("https://e.com");
  });

  test("defaults search_complete.degraded to false when absent", () => {
    const degraded = parseChunk('{"type":"search_complete","resultCount":0,"degraded":true}') as SearchCompleteChunk;
    expect(degraded.degraded).toBe(true);
    const normal = parseChunk('{"type":"search_complete","resultCount":5}') as SearchCompleteChunk;
    expect(normal.degraded).toBe(false);
  });

  test("parses debate chunks", () => {
    const dec = parseChunk('{"type":"debate_decomposed","subClaims":["a","b"]}') as DebateDecomposedChunk;
    expect(dec.subClaims).toEqual(["a", "b"]);

    const round = parseChunk('{"type":"debate_round","round":0,"subClaimIndex":1}') as DebateRoundChunk;
    expect(round.round).toBe(0);
    expect(round.subClaimIndex).toBe(1);

    const arg = parseChunk(
      '{"type":"debate_argument","role":"role-a","content":"...","confidence":0.4,' +
        '"round":0,"subClaimIndex":0}',
    ) as DebateArgumentChunk;
    expect(arg.role).toBe("role-a");
    expect(arg.round).toBe(0);

    // A field this version does not model is dropped.
    const extra = parseChunk(
      '{"type":"debate_argument","role":"role-b","content":"...","confidence":0.4,' +
        '"round":1,"strategyLabel":"label-a","subClaimIndex":0}',
    );
    expect(extra).not.toHaveProperty("strategyLabel");
  });

  test("cache_result reads its source, and keeps an unknown source as its raw value", () => {
    const corpus = parseChunk('{"type":"cache_result","hit":true,"score":0.93,"source":"corpus"}') as CacheResultChunk;
    expect(corpus.source).toBe("corpus");
    const unknown = parseChunk('{"type":"cache_result","hit":true,"source":"source-a"}') as CacheResultChunk;
    expect(unknown.hit).toBe(true);
    expect(unknown.source).toBe("source-a");
  });

  // A published version cannot be changed, so a value a newer server adds to any
  // response enum must reach the caller as its raw string rather than fail the parse.
  test("keeps an unknown verdict as its raw value", () => {
    const done = parseChunk(
      '{"type":"done","result":{"claim":"x","verdict":"satire","confidence":0.5,"reasoning":"r",' +
        '"cacheHit":false,"route":"route-a","processingMs":1}}',
    ) as DoneChunk;
    expect(done.result.verdict).toBe("satire");
    expect(VERDICT_LABELS[done.result.verdict] ?? done.result.verdict).toBe("satire");
    const complete = parseChunk(
      '{"type":"factcheck_complete","verdict":"satire","confidence":0.5}',
    ) as FactcheckCompleteChunk;
    expect(complete.verdict).toBe("satire");
  });

  test("keeps an unknown status as its raw value", () => {
    const batch = BatchSchema.parse({
      batch_id: "b",
      status: "paused",
      total: 1,
      pending: 1,
      done: 0,
      failed: 0,
      created_at: "2026-10-20T00:00:00Z",
      items: [{ idx: 0, claim: "c", status: "retrying" }],
    });
    expect(batch.status).toBe("paused");
    expect(batch.items[0]!.status).toBe("retrying");
    const job = CatalogueEnrollJobSchema.parse({
      jobId: "j",
      status: "throttled",
      total: 0,
      completed: 0,
      assets: [],
      gallerySize: null,
      maxAssets: null,
      receipts: [],
      error: null,
    });
    expect(job.status).toBe("throttled");
  });

  test("keeps an unknown value in a nested object as its raw value", () => {
    const forensics = parseChunk(
      '{"type":"media_forensics","modality":"hologram","result":{"verdict":"edited","method":"fisher",' +
        '"combinedP":null,"channels":[{"channel":"c2pa","verdict":"edited","pValue":null,' +
        '"coverageValid":true,"scope":"s"}],"excised":[],"alpha":0.01}}',
    ) as MediaForensicsChunk;
    expect(forensics.modality).toBe("hologram");
    expect(forensics.result.method).toBe("fisher");
    expect(forensics.result.channels[0]!.verdict).toBe("edited");

    const article = parseChunk(
      '{"type":"article_done","result":{"claimCount":1,"verifiedCount":1,"degradedCount":0,' +
        '"overallVerdict":"satire","overallConfidence":0.5,"summary":"s","extractionMethod":"model",' +
        '"claims":[{"claim":"x","verdict":"satire","confidence":0.5,"reasoning":"r",' +
        '"cacheHit":false,"route":"route-a","processingMs":1}],"processingMs":10}}',
    ) as ArticleDoneChunk;
    expect(article.result.overallVerdict).toBe("satire");
    expect(article.result.claims[0]!.verdict).toBe("satire");

    const extracted = parseChunk(
      '{"type":"claims_extracted","count":1,"method":"model","claims":[{"claim":"c",' +
        '"checkWorthiness":0.8,"claimType":"comparative","originalText":"o","verifiable":true}]}',
    ) as ClaimsExtractedChunk;
    expect(extracted.claims[0]!.claimType).toBe("comparative");
  });

  test("a result keeps parsing past fields this version does not model", () => {
    const done = parseChunk(
      '{"type":"done","result":{"claim":"x","verdict":"fake","confidence":0.9,"reasoning":"r",' +
        '"citations":[],"cacheHit":false,"route":"route-a","processingMs":1,' +
        '"timings":{"stage-a":12},"degraded":true}}',
    ) as DoneChunk;
    expect(done.result).not.toHaveProperty("timings");
    expect(done.result.degraded).toBe(true);
    const ocr = parseChunk('{"type":"ocr_complete","textChars":5,"language":"en","model":"model-a"}') as OcrCompleteChunk;
    expect(ocr.textChars).toBe(5);
    expect(ocr).not.toHaveProperty("model");
  });

  test("still parses terminal chunks that carry the server's billable usage", () => {
    // Terminal events can carry a `usage` object beside the result. This version of
    // the client does not model it, and must not fail on it.
    const usage = '"usage":{"inputTokens":7000,"outputTokens":3000,"searches":1},';
    const done = parseChunk(
      `{"type":"done",${usage}"result":{"claim":"x","verdict":"true","confidence":0.9,` +
        '"reasoning":"r","citations":[],"cacheHit":false,"route":"route-a","processingMs":1}}',
    ) as DoneChunk;
    expect(done.type).toBe("done");
    expect(done.result.verdict).toBe("true");

    const articleDone = parseChunk(
      `{"type":"article_done",${usage}"result":{"claimCount":1,"verifiedCount":1,"degradedCount":0,` +
        '"overallVerdict":"true","overallConfidence":0.9,"summary":"s","extractionMethod":"model",' +
        '"claims":[],"processingMs":10}}',
    ) as ArticleDoneChunk;
    expect(articleDone.result.claimCount).toBe(1);
  });

  test("parses article chunks", () => {
    const extracted = parseChunk(
      '{"type":"claims_extracted","count":1,"method":"model","claims":[' +
        '{"claim":"c","checkWorthiness":0.8,"claimType":"numerical","originalText":"o",' +
        '"entities":["E"],"verifiable":true}]}',
    ) as ClaimsExtractedChunk;
    expect(extracted.claims[0].claimType).toBe("numerical");
    expect(extracted.claims[0].checkWorthiness).toBe(0.8);

    const articleDone = parseChunk(
      '{"type":"article_done","result":{"claimCount":1,"verifiedCount":1,"degradedCount":0,"overallVerdict":"true",' +
        '"overallConfidence":0.9,"summary":"s","extractionMethod":"model","claims":[],"processingMs":10}}',
    ) as ArticleDoneChunk;
    expect(articleDone.result.overallVerdict).toBe("true");
  });

  test("parses media forensics and factcheck thinking chunks", () => {
    const thinking = parseChunk('{"type":"factcheck_thinking","delta":"weighing"}') as FactcheckThinkingChunk;
    expect(thinking.delta).toBe("weighing");

    // Every disclosure field present.
    const forensics = parseChunk(
      JSON.stringify({
        type: "media_forensics",
        modality: "image",
        result: {
          verdict: "synthetic",
          method: "hard",
          combinedP: 0,
          channels: [
            {
              channel: "retrieval",
              verdict: "synthetic",
              pValue: null,
              coverageValid: true,
              scope: "enrolled set",
              caveats: ["A no-match does not mean the file is authentic."],
              detail: "matches enrolled asset(s): poster.png",
              gradeCeiling: "grade-a",
              scopeCaveats: ["single-operation edits"],
              gallerySize: 12,
              evidence: { package_seal: "abc" },
            },
          ],
          excised: [],
          alpha: 0.01,
          unavailable: [],
        },
      }),
    ) as MediaForensicsChunk;
    expect(forensics.result.channels[0].scopeCaveats).toEqual(["single-operation edits"]);
    expect(forensics.result.channels[0].gallerySize).toBe(12);

    // No optional disclosure fields, which default rather than reject, and fields this
    // version does not model, which are dropped.
    const sparse = parseChunk(
      '{"type":"media_forensics","modality":"image","result":{"verdict":"unknown","method":"none",' +
        '"combinedP":null,"channels":[{"channel":"c2pa","verdict":"unknown","pValue":null,' +
        '"coverageValid":true,"scope":"s","caveats":["c"],"model":"model-a","controlNumbers":["control-a"]}],' +
        '"excised":[],"alpha":0.01}}',
    ) as MediaForensicsChunk;
    expect(sparse.result.channels[0].detail).toBe("");
    expect(sparse.result.unavailable).toEqual([]);
    expect(sparse.result.channels[0]).not.toHaveProperty("model");
    expect(sparse.result.channels[0]).not.toHaveProperty("controlNumbers");
  });

  test("parses the media_done terminal event", () => {
    const done = parseChunk('{"type":"media_done","modality":"video"}') as MediaDoneChunk;
    expect(done.modality).toBe("video");
  });

  test("rejects a media forensics verdict of real", () => {
    // There is no "real" member; a server that sent one is broken, not informative.
    expect(() =>
      parseChunk(
        '{"type":"media_forensics","modality":"image","result":{"verdict":"real","method":"none",' +
          '"combinedP":null,"channels":[],"excised":[],"alpha":0.01}}',
      ),
    ).toThrow(CantiviaError);
  });

  test("returns null for an event type it does not know", () => {
    // A newer API may add event types; this version skips them rather than failing.
    expect(parseChunk('{"type":"heartbeat"}')).toBeNull();
    expect(parseChunk('{"type":"event_from_a_newer_api","result":{"anything":1}}')).toBeNull();
  });

  test("still rejects a known type with bad fields, or a payload without a type", () => {
    expect(() => parseChunk('{"type":"routing","action":"a"}')).toThrow("unrecognised chunk");
    expect(() => parseChunk('{"message":"no type"}')).toThrow(CantiviaError);
  });

  test("wraps malformed JSON", () => {
    expect(() => parseChunk('{"type":"routing", not valid json')).toThrow(CantiviaError);
  });
});
