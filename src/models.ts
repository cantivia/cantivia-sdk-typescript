/**
 * Zod schemas for the Cantivia API's requests, results and stream events.
 *
 * Requests are validated before they are sent, so a bad argument fails fast with a
 * `CantiviaError` instead of a round trip. Results are validated as they arrive.
 *
 * Wire-format note: the verification, catalogue, resolve and paper-mill endpoints
 * are camelCase and pass through unchanged, while the usage and batch endpoints are
 * snake_case (`key_id`, `batch_id`, `processing_ms`) and are normalised to
 * camelCase here, so the whole public surface is camelCase.
 */

import { z } from "zod";

import { CantiviaError } from "./errors.js";

/**
 * A response value from a set the server may add to: one of the known values `T`,
 * or a string this version does not know. `string & {}` keeps editor completion for
 * the known values. Compare against them; treat any other value as unknown.
 */
export type OpenEnum<T extends string> = T | (string & {});

// A published version cannot be changed, so a value the server adds later reaches
// the caller as its raw string instead of failing the whole parse. Requests stay
// strict.
function openEnum<T extends string>(known: z.ZodType<T>): z.ZodType<OpenEnum<T>> {
  return z.union([known, z.string()]);
}

// Enumerated wire values, kept together so a change to their spelling touches one
// place.

/** Which cache answered a cache hit. Informational. */
export const CacheHitSourceSchema = z.enum(["corpus", "memory"]);
export type CacheHitSource = z.infer<typeof CacheHitSourceSchema>;

/**
 * A product id in a usage report: `factcheck`, `praetorian` (media forensics),
 * `titrate` or `papermill`.
 */
export const ProductIdSchema = z.string();

export const VerdictSchema = z.enum([
  "true",
  "mostly_true",
  "partially_true",
  "misleading",
  "fake",
  "mostly_fake",
  "unverifiable",
  // Returned when the input was not a checkable claim (a greeting, a question, a
  // request for something else). Distinct from `unverifiable`, which means a real
  // claim was checked and could not be settled.
  "not_a_claim",
]);
export type Verdict = z.infer<typeof VerdictSchema>;

// TitleCase labels for display to end users. The snake_case schema value is the
// wire/storage form; these are the only place a human-facing spelling lives. A
// verdict this version does not know has no label: `VERDICT_LABELS[v] ?? v`.
export const VERDICT_LABELS: Readonly<Record<Verdict, string>> & Readonly<Partial<Record<string, string>>> = {
  true: "True",
  mostly_true: "Mostly true",
  partially_true: "Partially true",
  misleading: "Misleading",
  fake: "Fake",
  mostly_fake: "Mostly fake",
  unverifiable: "Unverifiable",
  not_a_claim: "Not a claim",
};

// `url` is intentionally a plain string, not `z.string().url()`: the server
// validates URL-ness on the way out, and a client should not reject an otherwise
// usable result over a malformed citation URL (matches the Python client).
export const CitationSchema = z.object({
  url: z.string(),
  quote: z.string(),
});
export type Citation = z.infer<typeof CitationSchema>;

// Cap on the text payload, matching the API. Sized for an article body rather
// than a single claim, which is why it is not the tighter bound a lone claim
// would suggest.
export const MAX_CLAIM_CHARS = 50_000;

// Cap on a social post reference, matching the API.
export const MAX_POST_URL_CHARS = 2048;

export const VerificationRequestSchema = z.object({
  claim: z.string().min(1).max(MAX_CLAIM_CHARS),
  language: z.string().default("en"),
  priority: z.enum(["standard", "high"]).default("standard"),
  // The Bluesky post the claim came from. When the server has Titrate enabled,
  // the stream then also carries a `titrate` chunk for that post.
  postUrl: z.string().max(MAX_POST_URL_CHARS).optional(),
});
export type VerificationRequest = z.infer<typeof VerificationRequestSchema>;

// A Titrate request (kind: "post"): scores a social post's spread and nothing
// else. No fact-check runs, and the stream carries a single `titrate` chunk.
// `postUrl` is a bsky.app post link or an at:// post URI.
export const PostTitrateRequestSchema = z.object({
  postUrl: z.string().min(1).max(MAX_POST_URL_CHARS),
  kind: z.literal("post").default("post"),
});
export type PostTitrateRequest = z.infer<typeof PostTitrateRequestSchema>;

// A document verification request (kind: "article"): the server splits the text
// into check-worthy claims, verifies each independently and aggregates them, so
// the terminal event is `article_done`, not `done`. `claim` carries the article
// *text* — the server does not fetch URLs, so passing a link verifies the link
// string rather than the page behind it.
export const ArticleVerificationRequestSchema = z.object({
  claim: z.string().min(1).max(MAX_CLAIM_CHARS),
  kind: z.literal("article").default("article"),
  language: z.string().default("en"),
  priority: z.enum(["standard", "high"]).default("standard"),
});
export type ArticleVerificationRequest = z.infer<typeof ArticleVerificationRequestSchema>;

// Cap on a base64 image payload, matching the API: ~8 MB of base64 ≈ a 6 MB image.
export const MAX_IMAGE_B64_CHARS = 8_000_000;

// An image verification request (kind: "image"): the image's text is read and
// then checked like an article, so the terminal event is `article_done`, not `done`.
export const ImageVerificationRequestSchema = z.object({
  image: z.string().min(1).max(MAX_IMAGE_B64_CHARS),
  kind: z.literal("image").default("image"),
  language: z.string().default("en"),
  priority: z.enum(["standard", "high"]).default("standard"),
  // Media forensics alone: no OCR and no fact-check, and the stream ends in
  // `media_done` rather than `article_done`. Absent means false.
  forensicsOnly: z.boolean().optional(),
});
export type ImageVerificationRequest = z.infer<typeof ImageVerificationRequestSchema>;

// Audio and video requests (kind: "audio" / "video"): the file goes to media
// forensics alone — C2PA provenance and a match against the account's own enrolled
// catalogue. No claim is checked, so the stream is one `media_forensics` chunk and
// `media_done`. `media` is base64 (a `data:` URI prefix is accepted by the server).
export const AudioVerificationRequestSchema = z.object({
  media: z.string().min(1).max(MAX_IMAGE_B64_CHARS),
  mime: z.string().max(255).optional(),
  kind: z.literal("audio").default("audio"),
});
export type AudioVerificationRequest = z.infer<typeof AudioVerificationRequestSchema>;

export const VideoVerificationRequestSchema = z.object({
  media: z.string().min(1).max(MAX_IMAGE_B64_CHARS),
  mime: z.string().max(255).optional(),
  kind: z.literal("video").default("video"),
});
export type VideoVerificationRequest = z.infer<typeof VideoVerificationRequestSchema>;

// Per-customer media catalogue. Media enrolled by an account is matched by every
// later image, audio or video check from that account, and by no other account; every
// key the account holds shares it. A batch is small because it is one request body,
// capped like a single image.
export const MAX_CATALOGUE_BATCH = 10;

export const CatalogueEnrollRequestSchema = z.object({
  assets: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        media: z.string().min(1).max(MAX_IMAGE_B64_CHARS),
      }),
    )
    .min(1)
    .max(MAX_CATALOGUE_BATCH),
  source: z.string().max(100).default("api"),
});
export type CatalogueEnrollRequest = z.input<typeof CatalogueEnrollRequestSchema>;

// How the catalogue names an asset: the lowercase hex SHA-256 of its bytes.
export const CatalogueAssetIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

// An enrolment job: what enrolment answers at once (202), and what the job endpoint
// answers as it runs. queued -> running -> done, or failed when no asset was enrolled.
export const CatalogueEnrollJobSchema = z.object({
  jobId: z.string(),
  status: openEnum(z.enum(["queued", "running", "done", "failed"])),
  total: z.number(),
  completed: z.number(),
  assets: z.array(
    z.object({
      name: z.string(),
      assetId: CatalogueAssetIdSchema,
      // duplicate: the catalogue already held these exact bytes; nothing is billed.
      status: openEnum(z.enum(["pending", "enrolled", "duplicate", "failed"])),
      reason: z.string().nullable(),
    }),
  ),
  // How many assets the catalogue holds and the most it can hold, null until an
  // asset has been processed.
  gallerySize: z.number().nullable(),
  maxAssets: z.number().nullable(),
  // One signed receipt per asset enrolled. Each certifies ingestion, not authenticity.
  receipts: z.array(z.record(z.string(), z.unknown())),
  error: z.string().nullable(),
});
export type CatalogueEnrollJob = z.infer<typeof CatalogueEnrollJobSchema>;

export const CatalogueNoticeRequestSchema = z.object({
  // The copy found in the wild. A notice is drafted only if it matches the catalogue.
  name: z.string().min(1).max(255),
  media: z.string().min(1).max(MAX_IMAGE_B64_CHARS),
  infringingUrl: z.string().max(2048),
  host: z.string().max(255).default(""),
  complainant: z.object({
    name: z.string().min(1).max(200),
    organisation: z.string().max(200).default(""),
    email: z.string().max(254).default(""),
    address: z.string().max(500).default(""),
  }),
});
export type CatalogueNoticeRequest = z.input<typeof CatalogueNoticeRequestSchema>;

// A drafted notice. READY_FOR_REVIEW means a named person must check and approve it
// before anyone sends it — nothing has been sent. A miss is UNKNOWN and drafts nothing.
export const CatalogueNoticeResponseSchema = z.object({
  outcome: openEnum(z.enum(["MATCH", "UNKNOWN"])),
  status: openEnum(z.literal("READY_FOR_REVIEW")).nullable(),
  notice: z.record(z.string(), z.unknown()).nullable(),
  noticeText: z.string().nullable(),
  detail: z.string(),
});
export type CatalogueNoticeResponse = z.infer<typeof CatalogueNoticeResponseSchema>;

// What the catalogue holds, for the GDPR access right and to find the id to erase.
// Metadata only: the catalogue never keeps the uploaded bytes.
export const CatalogueAssetRecordSchema = z.object({
  assetId: CatalogueAssetIdSchema,
  name: z.string(),
  modality: z.string(),
  enrolledAt: z.string(),
  source: z.string(),
  bytesLen: z.number(),
});
export type CatalogueAssetRecord = z.infer<typeof CatalogueAssetRecordSchema>;

export const CatalogueListResponseSchema = z.object({
  assets: z.array(CatalogueAssetRecordSchema),
  gallerySize: z.number(),
  maxAssets: z.number(),
});
export type CatalogueListResponse = z.infer<typeof CatalogueListResponseSchema>;

// Erasure hard-deletes the asset and everything the catalogue held for it.
export const CatalogueDeleteResponseSchema = z.object({
  deleted: z.literal(true),
  assetId: z.string(),
  gallerySize: z.number(),
  maxAssets: z.number(),
});
export type CatalogueDeleteResponse = z.infer<typeof CatalogueDeleteResponseSchema>;

// Token counts for one part of the work on one request. `cacheReadTokens` and
// `cacheCreationTokens` are input tokens reused from, or stored for, earlier work;
// `contextWindow` is the token limit that part ran with. Every field is optional:
// an absent one means "not reported", never zero.
export const TokenUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  contextWindow: z.number().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

// Tokens one verification consumed, in total and broken down by part. The keys of
// `byModel` are opaque labels that may change between releases: sum them or ignore
// them, but do not branch on them. Only parts that report usage appear, so a
// missing part means unmeasured, not free.
export const RequestUsageSchema = z.object({
  byModel: z.record(z.string(), TokenUsageSchema).default({}),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
});
export type RequestUsage = z.infer<typeof RequestUsageSchema>;

export const VerificationResultSchema = z.object({
  claim: z.string(),
  verdict: openEnum(VerdictSchema),
  // A calibration signal for programmatic use; not a probability. Do not show it
  // to end users: show the verdict, the reasoning and the citations.
  confidence: z.number(),
  reasoning: z.string(),
  citations: z.array(CitationSchema).default([]),
  // Evidence URLs the search found, a superset of the ones cited.
  sources: z.array(z.string()).optional(),
  cacheHit: z.boolean(),
  // How the claim was handled. Informational; the set of values may grow.
  route: z.string(),
  processingMs: z.number(),
  // True when the verdict is the service's fallback rather than a judgment: the
  // check could not run to completion. It then reads `unverifiable`, so without
  // this an outage is indistinguishable from a claim the evidence did not settle.
  // Absent means false.
  degraded: z.boolean().optional(),
  // Tokens the check consumed. Absent when not reported, and on a cache hit, which
  // consumes none.
  usage: RequestUsageSchema.optional(),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

// One check-worthy claim pulled from a document (article mode). Decontextualised
// so it can be verified on its own.
export const ExtractedClaimSchema = z.object({
  claim: z.string(),
  checkWorthiness: z.number(),
  claimType: openEnum(
    z.enum(["numerical", "event", "causal", "quote", "prediction", "definitional", "other"]),
  ),
  originalText: z.string(),
  entities: z.array(z.string()).default([]),
  verifiable: z.boolean(),
});
export type ExtractedClaim = z.infer<typeof ExtractedClaimSchema>;

// Aggregate result for an "article" request: each extracted claim's verdict plus
// a check-worthiness-weighted overall verdict for the document.
export const ArticleVerificationResultSchema = z.object({
  claimCount: z.number(),
  // How many of `claimCount` reached a verdict other than `unverifiable`. The
  // overall verdict is computed from these alone, so read it with this count: "nine
  // claims checked out false" and "eight unsettled, one false" can share a verdict.
  verifiedCount: z.number(),
  // How many claims could not be checked at all, as opposed to checked and left
  // unsettled. Each reads `unverifiable` with `degraded` set. A high count means the
  // document is worth checking again later, not that it is ambiguous.
  degradedCount: z.number(),
  overallVerdict: openEnum(VerdictSchema),
  // A calibration signal for programmatic use; not a probability. Do not show it
  // to end users.
  overallConfidence: z.number(),
  summary: z.string(),
  extractionMethod: z.string(),
  claims: z.array(VerificationResultSchema).default([]),
  processingMs: z.number(),
});
export type ArticleVerificationResult = z.infer<typeof ArticleVerificationResultSchema>;

// The check has started. Informational: `action` names how the claim will be
// handled, and `difficulty` is how hard it was judged to be, from 0 to 1.
export const RoutingChunkSchema = z.object({
  type: z.literal("routing"),
  action: z.string(),
  difficulty: z.number(),
});
export type RoutingChunk = z.infer<typeof RoutingChunkSchema>;

// Whether an earlier check of the same claim answered this one.
export const CacheResultChunkSchema = z.object({
  type: z.literal("cache_result"),
  hit: z.boolean(),
  score: z.number().optional(),
  // Which cache answered a hit. Informational.
  source: openEnum(CacheHitSourceSchema).optional(),
});
export type CacheResultChunk = z.infer<typeof CacheResultChunkSchema>;

export const SearchCompleteChunkSchema = z.object({
  type: z.literal("search_complete"),
  resultCount: z.number(),
  // Character length of the evidence gathered, and the titles and URLs of the
  // sources found. Either may be absent.
  evidenceChars: z.number().optional(),
  sources: z.array(z.object({ title: z.string(), url: z.string() })).optional(),
  // True when the search produced no usable evidence: the verdict then comes back
  // "unverifiable" without a fact-check. False when absent.
  degraded: z.boolean().default(false),
});
export type SearchCompleteChunk = z.infer<typeof SearchCompleteChunkSchema>;

// Live progress text from the check, streamed as it is written. Progress, not a
// verdict: the text is unreviewed, and the verdict that follows can disagree.
export const FactcheckThinkingChunkSchema = z.object({
  type: z.literal("factcheck_thinking"),
  delta: z.string(),
});
export type FactcheckThinkingChunk = z.infer<typeof FactcheckThinkingChunkSchema>;

export const FactcheckCompleteChunkSchema = z.object({
  type: z.literal("factcheck_complete"),
  verdict: openEnum(VerdictSchema),
  // A calibration signal for programmatic use; not a probability. Do not show it
  // to end users.
  confidence: z.number(),
});
export type FactcheckCompleteChunk = z.infer<typeof FactcheckCompleteChunkSchema>;

export const ReasoningCompleteChunkSchema = z.object({
  type: z.literal("reasoning_complete"),
  verdict: openEnum(VerdictSchema),
});
export type ReasoningCompleteChunk = z.infer<typeof ReasoningCompleteChunkSchema>;

export const DoneChunkSchema = z.object({
  type: z.literal("done"),
  result: VerificationResultSchema,
});
export type DoneChunk = z.infer<typeof DoneChunkSchema>;

export const ErrorChunkSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  // Set by the client from the stream's `request-id` header, so an error seen
  // mid-stream can be quoted to support. Not part of the event itself.
  requestId: z.string().optional(),
});
export type ErrorChunk = z.infer<typeof ErrorChunkSchema>;

// Image mode: the image's text has been read; it is then checked like an article.
// Reports how much text was found and its language.
export const OcrCompleteChunkSchema = z.object({
  type: z.literal("ocr_complete"),
  textChars: z.number(),
  language: z.string(),
});
export type OcrCompleteChunk = z.infer<typeof OcrCompleteChunkSchema>;

// Media forensics answers "was this file made or altered by a known process?", a
// different question about a different object from the claim verdict. There is no
// "real" member and there must never be one: "unknown" means no enabled instrument
// found anything, not that the file is authentic.
export const MediaForensicsVerdictSchema = z.enum(["synthetic", "unknown"]);
export type MediaForensicsVerdict = z.infer<typeof MediaForensicsVerdictSchema>;

// Open like every other response enum, except that "real" fails the parse: a server
// that sent it is broken, and the value must never reach a caller to show.
const OpenMediaForensicsVerdictSchema = openEnum(MediaForensicsVerdictSchema).refine((v) => v !== "real");

// One instrument's reading of the file. Render `scope`, `caveats` and `detail` with
// the verdict: without them the verdict claims more than the instrument measured.
export const MediaForensicsChannelSchema = z.object({
  channel: z.string(),
  verdict: OpenMediaForensicsVerdictSchema,
  // A calibration signal for programmatic use. Do not show it to end users.
  pValue: z.number().nullable(),
  coverageValid: z.boolean(),
  scope: z.string(),
  caveats: z.array(z.string()).default([]),
  // What the instrument saw, in words — including why a no-match is a no-match.
  // Empty when absent.
  detail: z.string().default(""),
  // The strongest grade a positive from this channel can carry, and the scope
  // statements the answer rests on.
  gradeCeiling: z.string().nullable().optional(),
  scopeCaveats: z.array(z.string()).default([]),
  // Catalogue matching only: how many assets the catalogue held when this check ran.
  gallerySize: z.number().nullable().optional(),
  // Retrieval matches only: the sealed chain-of-custody package for the match.
  evidence: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type MediaForensicsChannel = z.infer<typeof MediaForensicsChannelSchema>;

export const MediaForensicsResultSchema = z.object({
  verdict: OpenMediaForensicsVerdictSchema,
  method: openEnum(z.enum(["hard", "sidak", "simes", "none"])),
  // A calibration signal for programmatic use. Do not show it to end users.
  combinedP: z.number().nullable(),
  channels: z.array(MediaForensicsChannelSchema).default([]),
  excised: z.array(z.string()).default([]),
  alpha: z.number(),
  // Channels that were switched on but could not run, and why.
  unavailable: z.array(z.object({ channel: z.string(), reason: z.string() })).default([]),
});
export type MediaForensicsResult = z.infer<typeof MediaForensicsResultSchema>;

// The media-forensics panel finished analysing the submitted file. Independent of
// any claim verdict in the same stream, and emitted only when a channel ran, so its
// absence means forensics was off, never that it found nothing.
export const MediaForensicsChunkSchema = z.object({
  type: z.literal("media_forensics"),
  modality: openEnum(z.enum(["image", "audio", "video"])),
  result: MediaForensicsResultSchema,
});
export type MediaForensicsChunk = z.infer<typeof MediaForensicsChunkSchema>;

// Audio and video mode terminal event: the `media_forensics` chunk before it is the answer.
export const MediaDoneChunkSchema = z.object({
  type: z.literal("media_done"),
  modality: openEnum(z.enum(["image", "audio", "video"])),
});
export type MediaDoneChunk = z.infer<typeof MediaDoneChunkSchema>;

// Article mode: the document was split into these check-worthy claims.
export const ClaimsExtractedChunkSchema = z.object({
  type: z.literal("claims_extracted"),
  count: z.number(),
  method: z.string(),
  claims: z.array(ExtractedClaimSchema),
});
export type ClaimsExtractedChunk = z.infer<typeof ClaimsExtractedChunkSchema>;

// Article mode: one extracted claim finished verifying (streamed as they land).
export const ClaimVerifiedChunkSchema = z.object({
  type: z.literal("claim_verified"),
  index: z.number(),
  total: z.number(),
  result: VerificationResultSchema,
});
export type ClaimVerifiedChunk = z.infer<typeof ClaimVerifiedChunkSchema>;

// Article mode terminal event (the per-document analogue of "done").
export const ArticleDoneChunkSchema = z.object({
  type: z.literal("article_done"),
  result: ArticleVerificationResultSchema,
});
export type ArticleDoneChunk = z.infer<typeof ArticleDoneChunkSchema>;

// Debate: the claim was split into these sub-claims, each argued on its own.
export const DebateDecomposedChunkSchema = z.object({
  type: z.literal("debate_decomposed"),
  subClaims: z.array(z.string()),
});
export type DebateDecomposedChunk = z.infer<typeof DebateDecomposedChunkSchema>;

// Debate: a new round of argument began for a sub-claim.
export const DebateRoundChunkSchema = z.object({
  type: z.literal("debate_round"),
  round: z.number(),
  subClaimIndex: z.number(),
});
export type DebateRoundChunk = z.infer<typeof DebateRoundChunkSchema>;

// Debate: one argument in a round is complete. `role` names the position it argued.
// Progress, not a verdict: the verdict that follows can disagree with any argument.
export const DebateArgumentChunkSchema = z.object({
  type: z.literal("debate_argument"),
  role: z.string(),
  content: z.string(),
  // A calibration signal for programmatic use; not a probability. Do not show it
  // to end users.
  confidence: z.number(),
  round: z.number(),
  subClaimIndex: z.number(),
});
export type DebateArgumentChunk = z.infer<typeof DebateArgumentChunkSchema>;

// Why a post was not scored. Most live posts are not: most get no reply at all.
// `Titrate.detail` says the same in words. The four "too little activity" reasons
// differ only in which check found it; treat them alike.
export const TitrateAbstainReasonSchema = z.enum([
  // No post was given.
  "no_post_reference",
  // The link is not a Bluesky post.
  "unsupported_url",
  // Posts from this platform cannot be scored yet.
  "no_artifact_for_platform",
  // The post was deleted, blocked or is private.
  "post_not_found",
  // The post is a reply or a quote; score the post that started the thread.
  "not_a_root",
  // The thread could not be fetched just now; try again.
  "fetch_failed",
  // Nobody has replied to the post.
  "no_replies",
  // The post is under an hour old; try again once its first hour has passed.
  "window_open",
  // Too little activity in the post's first hour to call it.
  "too_little_to_featurise",
  "below_min_window_nodes",
  "prefix_shorter_than_k",
  "no_featurisable_window",
  // The thread could not be read.
  "malformed_thread",
  // The post could not be scored.
  "unscorable",
  // Titrate is unavailable; try again later.
  "unavailable",
]);
export type TitrateAbstainReason = z.infer<typeof TitrateAbstainReasonSchema>;

// The final thread size, root included, that `level` of posts like this land inside.
export const SizeRangeSchema = z.object({
  low: z.number(),
  high: z.number(),
  level: z.number(),
});
export type SizeRange = z.infer<typeof SizeRangeSchema>;

// Titrate's early-warning answer for a social post. It scores spread, not truth.
// `probability` is a calibration signal for programmatic use; do not show it to end
// users. Show `isViral`, the thread size it refers to (`viralThresholdSize`),
// `sizeRange` and `abstainReason`.
export const TitrateSchema = z.object({
  scored: z.boolean(),
  abstainReason: openEnum(TitrateAbstainReasonSchema).nullable(),
  detail: z.string().nullable(),
  // Only Bluesky posts are scored today; "reddit" is reserved.
  platform: openEnum(z.enum(["bluesky", "reddit"])).nullable(),
  postUri: z.string().nullable(),
  probability: z.number().nullable(),
  // `probability` against a threshold frozen into the model before any live run.
  isViral: z.boolean().nullable(),
  decisionThreshold: z.number().nullable(),
  viralThresholdSize: z.number().nullable(),
  horizonHours: z.number().nullable(),
  // The thread as fetched, and the part inside the window. A thread already past
  // `viralThresholdSize` is being described, not forecast.
  observedNodes: z.number().nullable(),
  nodesInWindow: z.number().nullable(),
  elapsedHours: z.number().nullable(),
  extrapolated: z.boolean().nullable(),
  // Null when not scored, or when the thread has already outgrown it.
  sizeRange: SizeRangeSchema.nullable().default(null),
  // Which scorer answered (`titrate`), and the exact version of it (a hash and a
  // format number), so an answer can be traced to the scorer that gave it.
  model: z.string(),
  artifactSha256: z.string().nullable(),
  artifactFormatVersion: z.number().nullable(),
});
export type Titrate = z.infer<typeof TitrateSchema>;

// Titrate: a `post` request, or a claim request that carried `postUrl`.
export const TitrateChunkSchema = z.object({
  type: z.literal("titrate"),
  result: TitrateSchema,
});
export type TitrateChunk = z.infer<typeof TitrateChunkSchema>;

export const StreamChunkSchema = z.discriminatedUnion("type", [
  RoutingChunkSchema,
  CacheResultChunkSchema,
  SearchCompleteChunkSchema,
  FactcheckThinkingChunkSchema,
  FactcheckCompleteChunkSchema,
  ReasoningCompleteChunkSchema,
  DoneChunkSchema,
  OcrCompleteChunkSchema,
  MediaForensicsChunkSchema,
  MediaDoneChunkSchema,
  ClaimsExtractedChunkSchema,
  ClaimVerifiedChunkSchema,
  ArticleDoneChunkSchema,
  DebateDecomposedChunkSchema,
  DebateRoundChunkSchema,
  DebateArgumentChunkSchema,
  TitrateChunkSchema,
  ErrorChunkSchema,
]);
export type StreamChunk = z.infer<typeof StreamChunkSchema>;

const KNOWN_CHUNK_TYPES: ReadonlySet<unknown> = new Set(
  StreamChunkSchema.options.map((option) => option.shape.type.value),
);

/**
 * Parse one SSE `data:` payload into the matching typed stream chunk.
 *
 * Returns `null` for an event type this version does not know. The streaming
 * methods skip those, so a newer API that adds an event never breaks this version.
 * Throws `CantiviaError` if the payload is malformed JSON, or a known chunk type
 * whose fields do not match it, so callers never have to catch a raw `ZodError`.
 */
export function parseChunk(data: string): StreamChunk | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw new CantiviaError(`unrecognised chunk from server: ${data.slice(0, 200)}`);
  }
  const type = (json as { type?: unknown } | null)?.type;
  if (typeof type === "string" && !KNOWN_CHUNK_TYPES.has(type)) {
    return null;
  }
  const result = StreamChunkSchema.safeParse(json);
  if (!result.success) {
    throw new CantiviaError(`unrecognised chunk from server: ${data.slice(0, 200)}`);
  }
  return result.data;
}

// The usage endpoint serialises snake_case; this schema validates the wire shape
// and transforms it into the camelCase `Usage` the rest of the client exposes.
const UsageWireSchema = z
  .object({
    key_id: z.string(),
    requests: z.object({
      window: z.number(),
      today: z.number(),
      month: z.number(),
    }),
    rate_limit: z.object({
      limit: z.number(),
      remaining: z.number(),
      window_seconds: z.number(),
    }),
    verdicts: z.record(z.string(), z.number()).default({}),
    latency_ms: z.object({
      p50: z.number(),
      p95: z.number(),
      samples: z.number(),
    }),
    // Exact per-product billing state, summed across the account.
    products: z
      .array(
        z.object({
          product: ProductIdSchema,
          // "pilot", "active", "past_due", "cancelled" or "none".
          status: z.string(),
          tier: z.string().nullable(),
          pilot_ends_at: z.string().nullable(),
          units: z.array(
            z.object({
              // "claim", "media_check", "catalogue_item", "post_scored" or "manuscript_screened".
              unit: z.string(),
              used: z.number(),
              // Null with no entitlement, or an Enterprise limit not yet recorded.
              allowance: z.number().nullable(),
              // Units billed at API rates on top of the subscription; 0 on a pilot.
              overage: z.number(),
            }),
          ),
        }),
      )
      .default([]),
  })
  .transform((u) => ({
    keyId: u.key_id,
    requests: u.requests,
    rateLimit: {
      limit: u.rate_limit.limit,
      remaining: u.rate_limit.remaining,
      windowSeconds: u.rate_limit.window_seconds,
    },
    verdicts: u.verdicts,
    latencyMs: u.latency_ms,
    products: u.products.map((p) => ({
      product: p.product,
      status: p.status,
      tier: p.tier,
      pilotEndsAt: p.pilot_ends_at,
      units: p.units,
    })),
  }));

export type Usage = z.infer<typeof UsageWireSchema>;

/**
 * Per-key usage returned by `GET /api/v1/usage`, normalised to camelCase.
 *
 * Scoped strictly to the calling key, never global or cross-tenant data. The
 * request, verdict and latency counters are approximate usage insight that expires
 * over time. `products` is not: it is exact billing state, summed across every key
 * on the account, because a pilot or a subscription is granted to the account
 * rather than to one key.
 */
export function parseUsage(json: unknown): Usage {
  const result = UsageWireSchema.safeParse(json);
  if (!result.success) {
    throw new CantiviaError("unexpected usage payload from server");
  }
  return result.data;
}

// Resolve: rewrite a conversational follow-up into a standalone claim, using the
// claims the conversation has already checked.
export const MAX_PRIOR_CLAIMS = 20;
export const MAX_FOLLOW_UP_CHARS = 4000;

export const ResolveRequestSchema = z.object({
  // Earlier claims only, never their verdicts.
  priorClaims: z.array(z.string()).max(MAX_PRIOR_CLAIMS).default([]),
  followUp: z.string().min(1).max(MAX_FOLLOW_UP_CHARS),
});
export type ResolveRequest = z.input<typeof ResolveRequestSchema>;

export const ResolveResultSchema = z.object({
  // The text to verify: the rewrite, or the follow-up untouched.
  claim: z.string(),
  // False whenever nothing was rewritten, including when resolution failed. Show the
  // user the rewritten claim only when this is true.
  resolved: z.boolean(),
  // How the answer was reached, for example `passthrough` (nothing to resolve
  // against) or `model`.
  method: z.string(),
});
export type ResolveResult = z.infer<typeof ResolveResultSchema>;

// Paper-mill screen: reads one manuscript's title and abstract and says whether a
// person should look at it. It scores writing style, not fraud.
export const MAX_MANUSCRIPT_TITLE_CHARS = 2000;
export const MAX_MANUSCRIPT_ABSTRACT_CHARS = 20_000;

// At least one of `title` and `abstract` must hold text; `screenManuscript` checks it.
export const PaperMillScreenRequestSchema = z.object({
  title: z.string().max(MAX_MANUSCRIPT_TITLE_CHARS).default(""),
  abstract: z.string().max(MAX_MANUSCRIPT_ABSTRACT_CHARS).default(""),
  // The share of submissions your team can review, e.g. 0.01 for one in a hundred.
  // The screen flags at that rate.
  budget: z.number().gt(0).lte(1).optional(),
});
export type PaperMillScreenRequest = z.input<typeof PaperMillScreenRequestSchema>;

export const PaperMillScreenResultSchema = z.object({
  // review: a person should read this. pass: no reason to. unavailable: the screen
  // could not run. There is deliberately no "fraudulent" and no "clean": a
  // legitimate paper written to the genre's formula can score like a mill product.
  decision: openEnum(z.enum(["review", "pass", "unavailable"])),
  // Null when the manuscript holds nothing the screen can read.
  score: z.number().nullable(),
  // The flag rate this manuscript cleared, with the precision measured at that rate
  // on held-out papers and its interval.
  band: z.number().nullable(),
  precision: z.number().nullable(),
  precisionInterval: z.tuple([z.number(), z.number()]).nullable(),
  // The terms that pushed the score up, with their weights.
  evidence: z.array(z.tuple([z.string(), z.number()])),
  // What the score does not mean. Show these with the decision.
  caveats: z.array(z.string()),
  // Which version of the screen answered: `cohort` names the collection of papers it
  // was trained on, `trainedThrough` is the last publication year in it, and
  // `trainedOn` holds counts describing it, such as how many papers it held.
  model: z
    .object({
      cohort: z.string(),
      trainedThrough: z.number(),
      trainedOn: z.record(z.string(), z.number()),
    })
    .nullable(),
  error: z.string().nullable(),
});
export type PaperMillScreenResult = z.infer<typeof PaperMillScreenResultSchema>;

// Batch verification: up to 500 claims (or articles) checked in the background.
export const MAX_BATCH_CLAIMS = 500;
// Tighter than MAX_CLAIM_CHARS: a batch carries many items in one request.
export const MAX_BATCH_CLAIM_CHARS = 10_000;

export const BatchRequestSchema = z.object({
  claims: z
    .array(
      z
        .string()
        .refine((claim) => claim.trim().length > 0, "a claim is empty")
        .refine(
          (claim) => [...claim].length <= MAX_BATCH_CLAIM_CHARS,
          `a claim exceeds ${MAX_BATCH_CLAIM_CHARS} characters`,
        ),
    )
    .min(1)
    .max(MAX_BATCH_CLAIMS),
  kind: z.enum(["claim", "article"]).default("claim"),
});
export type BatchRequest = z.input<typeof BatchRequestSchema>;

/** What submitting a batch answers at once. Normalised from the snake_case wire form. */
export const BatchAcceptedSchema = z
  .object({
    batch_id: z.string(),
    total: z.number(),
    status: z.string(),
  })
  .transform((b) => ({ batchId: b.batch_id, total: b.total, status: b.status }));
export type BatchAccepted = z.output<typeof BatchAcceptedSchema>;

/**
 * A batch's progress and results. Normalised from the snake_case wire form.
 * A batch is `queued`, then `running`, then `completed` (every item is `done` or
 * `failed`) or `failed`.
 */
export const BatchSchema = z
  .object({
    batch_id: z.string(),
    status: openEnum(z.enum(["queued", "running", "completed", "failed"])),
    total: z.number(),
    pending: z.number(),
    done: z.number(),
    failed: z.number(),
    created_at: z.string(),
    finished_at: z.string().nullish(),
    items: z.array(
      z.object({
        idx: z.number(),
        claim: z.string(),
        status: openEnum(z.enum(["pending", "done", "failed"])),
        // Set once the item is done.
        verdict: z.string().optional(),
        // A calibration signal for programmatic use; not a probability. Do not show
        // it to end users.
        confidence: z.number().optional(),
        reasoning: z.string().optional(),
        citations: z.array(CitationSchema).nullish(),
        degraded: z.boolean().optional(),
        processing_ms: z.number().optional(),
        // Set when the item failed.
        error: z.string().optional(),
      }),
    ),
  })
  .transform((b) => ({
    batchId: b.batch_id,
    status: b.status,
    total: b.total,
    pending: b.pending,
    done: b.done,
    failed: b.failed,
    createdAt: b.created_at,
    finishedAt: b.finished_at ?? null,
    items: b.items.map((item) => ({
      idx: item.idx,
      claim: item.claim,
      status: item.status,
      verdict: item.verdict,
      confidence: item.confidence,
      reasoning: item.reasoning,
      citations: item.citations ?? [],
      degraded: item.degraded,
      processingMs: item.processing_ms,
      error: item.error,
    })),
  }));
export type Batch = z.output<typeof BatchSchema>;
export type BatchItem = Batch["items"][number];
