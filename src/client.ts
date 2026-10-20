/**
 * HTTP client for the Cantivia API.
 *
 * One async client: JavaScript HTTP is promise-based, so there is no separate sync
 * client. Uses the global `fetch` and Web Streams, so it runs unchanged in Node 18+,
 * Bun, Deno, browsers and edge runtimes with no transport dependency.
 */

import {
  APIConnectionError,
  APITimeoutError,
  CantiviaError,
  makeStatusError,
  VerificationError,
} from "./errors.js";
import {
  parseChunk,
  parseUsage,
  ArticleVerificationRequestSchema,
  AudioVerificationRequestSchema,
  BatchAcceptedSchema,
  BatchRequestSchema,
  BatchSchema,
  CatalogueAssetIdSchema,
  CatalogueDeleteResponseSchema,
  CatalogueEnrollRequestSchema,
  CatalogueEnrollJobSchema,
  CatalogueListResponseSchema,
  CatalogueNoticeRequestSchema,
  CatalogueNoticeResponseSchema,
  ImageVerificationRequestSchema,
  PaperMillScreenRequestSchema,
  PaperMillScreenResultSchema,
  PostTitrateRequestSchema,
  ResolveRequestSchema,
  ResolveResultSchema,
  VerificationRequestSchema,
  VideoVerificationRequestSchema,
  type ArticleVerificationResult,
  type Batch,
  type BatchAccepted,
  type BatchRequest,
  type CatalogueDeleteResponse,
  type CatalogueEnrollRequest,
  type CatalogueEnrollJob,
  type CatalogueListResponse,
  type CatalogueNoticeRequest,
  type CatalogueNoticeResponse,
  type MediaForensicsResult,
  type PaperMillScreenRequest,
  type PaperMillScreenResult,
  type ResolveResult,
  type StreamChunk,
  type Titrate,
  type Usage,
  type VerificationResult,
} from "./models.js";
import { DEFAULT_MAX_RETRIES, parseRetryAfter, withRetries } from "./retry.js";
import { aiterSSE, decodeStreamToLines } from "./sse.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.cantivia.com";
// A request, or a stream, that goes this long without receiving data times out.
// Long fact-checks stream progress, so they stay within it.
export const DEFAULT_TIMEOUT_MS = 600_000;

// Enrolment takes seconds to minutes per asset, so a waited enrolment reads its job
// at this pace, for at most this long.
const ENROLL_POLL_INTERVAL_MS = 2_000;
const ENROLL_MAX_WAIT_MS = 10 * 60_000;

// A batch runs a few items at a time, each taking tens of seconds.
const BATCH_POLL_INTERVAL_MS = 5_000;
const BATCH_MAX_WAIT_MS = 60 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USER_AGENT = `cantivia-typescript/${VERSION}`;

function parseWith<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, body: unknown, what: string): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new CantiviaError(`unexpected ${what} payload from server`);
  }
  return result.data;
}

/** Read an environment variable where the runtime has one (Node, Bun, Deno with --allow-env). */
function readEnv(name: string): string | undefined {
  try {
    const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
    return value?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The subset of `fetch` this client relies on; injectable for tests and proxies. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CantiviaClientOptions {
  /**
   * API key, sent as `Authorization: Bearer <key>`. Defaults to the
   * `CANTIVIA_API_KEY` environment variable.
   */
  apiKey?: string;
  /**
   * API base URL. Defaults to the `CANTIVIA_BASE_URL` environment variable, then
   * `https://api.cantivia.com`. Trailing slashes are trimmed.
   */
  baseUrl?: string;
  /**
   * Milliseconds a request, or a stream, may go without receiving data before it
   * fails with `APITimeoutError` (default 600000; 0 disables). Timeouts are never
   * retried.
   */
  timeoutMs?: number;
  /**
   * How many times to retry a request that never reached the service: a connection
   * failure, or a 429 or 503 refusal (default 2; 0 disables).
   */
  maxRetries?: number;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** Custom `fetch` implementation (e.g. a mock in tests). Defaults to the global. */
  fetch?: FetchLike;
}

/** Per-call options every method accepts. Each overrides the client's setting for one call. */
export interface RequestOptions {
  /** Abort signal; aborting rejects the call with the signal's reason. */
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface VerifyOptions extends RequestOptions {
  language?: string;
  priority?: "standard" | "high";
  /**
   * The Bluesky post the claim came from. When the server has Titrate enabled,
   * the stream also carries a `titrate` chunk for it. Ignored by article and image.
   */
  postUrl?: string;
}

export interface PollOptions<T> extends RequestOptions {
  /** Milliseconds between reads. */
  pollIntervalMs?: number;
  /** Milliseconds to wait in total before giving up. */
  maxWaitMs?: number;
  /** Called with every snapshot, the first included. */
  onProgress?: (snapshot: T) => void;
}

/**
 * A timeout that restarts whenever data arrives, joined with the caller's signal.
 * `failure` turns whatever a fetch or a body read threw into the error to surface.
 */
interface Deadline {
  signal: AbortSignal;
  touch: () => void;
  cleanup: () => void;
  failure: (err: unknown) => unknown;
}

function arm(timeoutMs: number, external?: AbortSignal): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = () => {
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new APITimeoutError(`Request timed out after ${timeoutMs}ms without data.`));
      }, timeoutMs);
    }
  };
  const onAbort = () => controller.abort(external?.reason);
  if (external?.aborted) {
    controller.abort(external.reason);
  } else {
    external?.addEventListener("abort", onAbort, { once: true });
  }
  start();
  return {
    signal: controller.signal,
    touch: () => {
      clearTimeout(timer);
      start();
    },
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
    failure: (err) => {
      if (timedOut) {
        return new APITimeoutError(`Request timed out after ${timeoutMs}ms without data.`, { cause: err });
      }
      if (external?.aborted) {
        return external.reason ?? err;
      }
      if (err instanceof CantiviaError) {
        return err;
      }
      return new APIConnectionError(`Connection error: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    },
  };
}

/** Wait `ms` between polls, or reject with the signal's reason as soon as it aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

export class CantiviaClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;

  constructor(options: CantiviaClientOptions = {}) {
    this.apiKey = options.apiKey || readEnv("CANTIVIA_API_KEY");
    this.baseUrl = (options.baseUrl ?? readEnv("CANTIVIA_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.headers = { "User-Agent": USER_AGENT, ...options.headers };
    if (this.apiKey) {
      this.headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (options.fetch) {
      this.fetchImpl = options.fetch;
    } else if (typeof globalThis.fetch === "function") {
      // Bind through an arrow so `this` stays `globalThis` (browsers throw an
      // "Illegal invocation" on a detached global fetch otherwise).
      this.fetchImpl = (input, init) => globalThis.fetch(input, init);
    } else {
      throw new CantiviaError(
        "no global fetch available; pass `fetch` in options (Node <18 has no global fetch)",
      );
    }
  }

  /**
   * Send one request, retrying what never reached the service, and return the
   * successful response with the deadline still armed so its body can be read.
   */
  private async send(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions & { auth?: boolean; headers?: Record<string, string> },
  ): Promise<{ response: Response; deadline: Deadline }> {
    if (options.auth !== false && !this.apiKey) {
      throw new CantiviaError(
        "No API key: pass `apiKey` to CantiviaClient or set the CANTIVIA_API_KEY environment variable.",
      );
    }
    const deadline = arm(options.timeoutMs ?? this.timeoutMs, options.signal);
    const headers = { ...this.headers, ...options.headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const init: RequestInit = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: deadline.signal,
    };
    try {
      const response = await withRetries(
        async () => {
          try {
            return await this.fetchImpl(`${this.baseUrl}${path}`, init);
          } catch (err) {
            throw deadline.failure(err);
          }
        },
        { maxRetries: options.maxRetries ?? this.maxRetries, signal: deadline.signal },
      );
      if (!response.ok) {
        const text = await safeText(response);
        throw makeStatusError(
          response.status,
          text,
          response.headers,
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }
      // The response head is data: the idle timeout restarts for the body.
      deadline.touch();
      return { response, deadline };
    } catch (err) {
      deadline.cleanup();
      throw err;
    }
  }

  private async requestJSON(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions & { auth?: boolean; headers?: Record<string, string> },
  ): Promise<unknown> {
    const { response, deadline } = await this.send(method, path, body, options);
    try {
      return await response.json();
    } catch (err) {
      // A body that arrived whole but is not JSON is the server's fault, not the network's.
      throw err instanceof SyntaxError ? new CantiviaError("response from server was not JSON") : deadline.failure(err);
    } finally {
      deadline.cleanup();
    }
  }

  /** Check that the API is reachable. Needs no API key. */
  async health(options: RequestOptions = {}): Promise<Record<string, unknown>> {
    return (await this.requestJSON("GET", "/health", undefined, { ...options, auth: false })) as Record<
      string,
      unknown
    >;
  }

  /**
   * Usage for the calling API key: request counts, rate-limit headroom, verdict
   * distribution and latency percentiles, plus each product's plan, units used and
   * allowance for the whole account.
   */
  async usage(options: RequestOptions = {}): Promise<Usage> {
    return parseUsage(await this.requestJSON("GET", "/api/v1/usage", undefined, options));
  }

  /** POST a verify body and yield the stream events it returns. */
  private async *streamVerify(body: unknown, options: RequestOptions): AsyncGenerator<StreamChunk> {
    const { response, deadline } = await this.send("POST", "/api/v1/verify", body, options);
    const requestId = response.headers.get("request-id") || undefined;
    try {
      if (!response.body) {
        throw new CantiviaError("verification response had no body to stream");
      }
      for await (const data of aiterSSE(decodeStreamToLines(response.body, deadline.touch))) {
        const chunk = parseChunk(data);
        if (chunk === null) {
          continue;
        }
        // An error event carries the stream's request id, so it can be quoted to support.
        yield chunk.type === "error" && requestId ? { ...chunk, requestId } : chunk;
      }
    } catch (err) {
      throw deadline.failure(err);
    } finally {
      deadline.cleanup();
    }
  }

  /**
   * Fact-check a claim, yielding each stage's event as it arrives: routing, search,
   * fact-check progress and the final `done` event carrying the result.
   */
  async *verifyStream(claim: string, options: VerifyOptions = {}): AsyncGenerator<StreamChunk> {
    const parsed = VerificationRequestSchema.safeParse({
      claim,
      language: options.language ?? "en",
      priority: options.priority ?? "standard",
      postUrl: options.postUrl,
    });
    if (!parsed.success) {
      throw new CantiviaError(`invalid verification request: ${parsed.error.message}`);
    }
    yield* this.streamVerify(parsed.data, options);
  }

  /**
   * Fact-check a claim and return the verdict, reasoning and citations.
   *
   * Throws `VerificationError` if the check reports an error, or `CantiviaError` if
   * the stream ends without a result.
   */
  async verify(claim: string, options: VerifyOptions = {}): Promise<VerificationResult> {
    let result: VerificationResult | undefined;
    for await (const chunk of this.verifyStream(claim, options)) {
      if (chunk.type === "error") {
        throw new VerificationError(chunk.message, { requestId: chunk.requestId });
      }
      if (chunk.type === "done") {
        result = chunk.result;
      }
    }
    if (result === undefined) {
      throw new CantiviaError("verification stream ended without a result");
    }
    return result;
  }

  /**
   * Fact-check a document (article, transcript, post). The text is split into
   * check-worthy claims and each is verified independently, so the stream carries
   * `claims_extracted`, then a `claim_verified` per claim, ending in `article_done`.
   *
   * `article` is the article *text*. URLs are not fetched, so passing a link checks
   * the link string, not the page behind it.
   */
  async *verifyArticleStream(
    article: string,
    options: VerifyOptions = {},
  ): AsyncGenerator<StreamChunk> {
    const parsed = ArticleVerificationRequestSchema.safeParse({
      claim: article,
      kind: "article",
      language: options.language ?? "en",
      priority: options.priority ?? "standard",
    });
    if (!parsed.success) {
      throw new CantiviaError(`invalid article verification request: ${parsed.error.message}`);
    }
    yield* this.streamVerify(parsed.data, options);
  }

  /**
   * Fact-check a document and return the per-claim verdicts and the overall verdict.
   *
   * Throws `VerificationError` if the check reports an error (including a failure
   * to extract claims), or `CantiviaError` if the stream ends without a result.
   */
  async verifyArticle(
    article: string,
    options: VerifyOptions = {},
  ): Promise<ArticleVerificationResult> {
    let result: ArticleVerificationResult | undefined;
    for await (const chunk of this.verifyArticleStream(article, options)) {
      if (chunk.type === "error") {
        throw new VerificationError(chunk.message, { requestId: chunk.requestId });
      }
      if (chunk.type === "article_done") {
        result = chunk.result;
      }
    }
    if (result === undefined) {
      throw new CantiviaError("article verification stream ended without a result");
    }
    return result;
  }

  /**
   * Fact-check an image (screenshot, meme, infographic). Its text is read and
   * checked like an article, so the stream carries `ocr_complete`, then the article
   * events (`claims_extracted`, `claim_verified`, `article_done`).
   *
   * With `forensicsOnly`, the image gets media forensics alone (no text reading and
   * no fact-check) and the stream is `media_forensics` then `media_done`;
   * `verifyMedia(image, "image")` returns that result directly.
   *
   * `image` is base64 (a `data:` URI prefix is accepted).
   */
  async *verifyImageStream(
    image: string,
    options: VerifyOptions & { forensicsOnly?: boolean } = {},
  ): AsyncGenerator<StreamChunk> {
    const parsed = ImageVerificationRequestSchema.safeParse({
      image,
      kind: "image",
      language: options.language ?? "en",
      priority: options.priority ?? "standard",
      forensicsOnly: options.forensicsOnly,
    });
    if (!parsed.success) {
      throw new CantiviaError(`invalid image verification request: ${parsed.error.message}`);
    }
    yield* this.streamVerify(parsed.data, options);
  }

  /**
   * Fact-check an image and return the aggregate result over every claim found in it.
   *
   * Throws `VerificationError` if the check reports an error (including an image
   * whose text could not be read), or `CantiviaError` if the stream ends without a
   * result.
   */
  async verifyImage(
    image: string,
    options: VerifyOptions = {},
  ): Promise<ArticleVerificationResult> {
    let result: ArticleVerificationResult | undefined;
    for await (const chunk of this.verifyImageStream(image, options)) {
      if (chunk.type === "error") {
        throw new VerificationError(chunk.message, { requestId: chunk.requestId });
      }
      if (chunk.type === "article_done") {
        result = chunk.result;
      }
    }
    if (result === undefined) {
      throw new CantiviaError("image verification stream ended without a result");
    }
    return result;
  }

  /**
   * Run media forensics on an image, an audio clip or a video: C2PA provenance, and
   * a match against this account's enrolled catalogue. No claim is checked, so the
   * stream is one `media_forensics` event then `media_done`, or an `error` when
   * media forensics is not enabled for the account.
   *
   * `media` is base64 (a `data:` URI prefix is accepted).
   */
  async *verifyMediaStream(
    media: string,
    modality: "image" | "audio" | "video",
    options: RequestOptions & { mime?: string } = {},
  ): AsyncGenerator<StreamChunk> {
    // An image through this path is forensics-only: no text reading and no fact-check.
    const parsed =
      modality === "image"
        ? ImageVerificationRequestSchema.safeParse({ image: media, kind: "image", forensicsOnly: true })
        : (modality === "audio" ? AudioVerificationRequestSchema : VideoVerificationRequestSchema).safeParse({
            media,
            mime: options.mime,
            kind: modality,
          });
    if (!parsed.success) {
      throw new CantiviaError(`invalid ${modality} verification request: ${parsed.error.message}`);
    }
    yield* this.streamVerify(parsed.data, options);
  }

  /**
   * Run media forensics on an image, an audio clip or a video and return the result.
   *
   * The verdict is `synthetic` or `unknown`, never "real". Show each channel's
   * `detail` and `caveats` with it, and read `unavailable` for
   * channels that could not run (retrieval before anything is enrolled). Throws
   * `VerificationError` on an error event, or `CantiviaError` if the stream ends
   * without a result.
   */
  async verifyMedia(
    media: string,
    modality: "image" | "audio" | "video",
    options: RequestOptions & { mime?: string } = {},
  ): Promise<MediaForensicsResult> {
    let result: MediaForensicsResult | undefined;
    for await (const chunk of this.verifyMediaStream(media, modality, options)) {
      if (chunk.type === "error") {
        throw new VerificationError(chunk.message, { requestId: chunk.requestId });
      }
      if (chunk.type === "media_forensics") {
        result = chunk.result;
      }
    }
    if (result === undefined) {
      throw new CantiviaError(`${modality} verification stream ended without a result`);
    }
    return result;
  }

  /**
   * Enrol media you hold the rights to into this account's catalogue, and wait for
   * the job to finish. Later image, audio and video checks with any of the account's
   * keys match copies of it; no other account sees it, and rotating a key keeps it.
   *
   * Submits the batch, then reads the job every 2 s (`pollIntervalMs`) until it is
   * `done` or `failed`, calling `onProgress` with every snapshot, the first included.
   * `done` can still carry failed assets: read each asset's `status` and `reason`. A
   * job unfinished after `maxWaitMs` (default 10 minutes) throws `CantiviaError`
   * naming its id; it keeps running, and `getEnrollmentJob` reads it on.
   */
  async enrollMedia(
    assets: CatalogueEnrollRequest["assets"],
    options: PollOptions<CatalogueEnrollJob> & { source?: string } = {},
  ): Promise<CatalogueEnrollJob> {
    const maxWaitMs = options.maxWaitMs ?? ENROLL_MAX_WAIT_MS;
    const deadline = Date.now() + maxWaitMs;
    let job = await this.startEnrollment(assets, options);
    for (;;) {
      options.onProgress?.(job);
      if (job.status === "done" || job.status === "failed") {
        return job;
      }
      if (Date.now() >= deadline) {
        throw new CantiviaError(
          `enrolment job ${job.jobId} did not finish within ${maxWaitMs}ms; read it on with getEnrollmentJob`,
        );
      }
      await pause(options.pollIntervalMs ?? ENROLL_POLL_INTERVAL_MS, options.signal);
      job = await this.getEnrollmentJob(job.jobId, options);
    }
  }

  /**
   * Submit a batch for enrolment and return the job at once (the server answers 202),
   * without waiting. `getEnrollmentJob` reads its progress.
   */
  async startEnrollment(
    assets: CatalogueEnrollRequest["assets"],
    options: RequestOptions & { source?: string } = {},
  ): Promise<CatalogueEnrollJob> {
    const parsed = CatalogueEnrollRequestSchema.safeParse({ assets, source: options.source });
    if (!parsed.success) {
      throw new CantiviaError(`invalid catalogue enrolment: ${parsed.error.message}`);
    }
    const body = await this.requestJSON("POST", "/api/v1/catalogue/assets", parsed.data, options);
    return parseWith(CatalogueEnrollJobSchema, body, "catalogue enrolment");
  }

  /**
   * Read an enrolment job's progress. A job expires an hour after it finishes and
   * then answers 404 (`NotFoundError`). Resubmitting the same assets enrols and
   * bills nothing twice, so a job that answers 404 can safely be submitted again.
   */
  async getEnrollmentJob(jobId: string, options: RequestOptions = {}): Promise<CatalogueEnrollJob> {
    // Checked before sending because it becomes part of the URL.
    if (!UUID.test(jobId)) {
      throw new CantiviaError("invalid enrolment job id: expected the UUID the enrolment answered with");
    }
    const body = await this.requestJSON("GET", `/api/v1/catalogue/jobs/${jobId}`, undefined, options);
    return parseWith(CatalogueEnrollJobSchema, body, "catalogue enrolment");
  }

  /**
   * List what this account's catalogue holds: each asset's id (the SHA-256 of its
   * bytes), name, modality and enrolment time, with the catalogue's size and cap.
   * Metadata only: the catalogue never keeps the uploaded bytes. Needs no active
   * plan.
   */
  async listCatalogue(options: RequestOptions = {}): Promise<CatalogueListResponse> {
    const body = await this.requestJSON("GET", "/api/v1/catalogue/assets", undefined, options);
    return parseWith(CatalogueListResponseSchema, body, "catalogue listing");
  }

  /**
   * Erase one asset from this account's catalogue: the asset and everything the
   * catalogue held for it are hard-deleted. `assetId` is the id `listCatalogue`
   * reports. Needs no active plan. An asset the catalogue does not hold answers 404
   * (`NotFoundError`).
   */
  async deleteCatalogueAsset(
    assetId: string,
    options: RequestOptions = {},
  ): Promise<CatalogueDeleteResponse> {
    // Checked before sending because it becomes part of the URL.
    if (!CatalogueAssetIdSchema.safeParse(assetId).success) {
      throw new CantiviaError(
        "invalid catalogue asset id: expected the 64-character lowercase hex SHA-256 of the asset's bytes",
      );
    }
    const body = await this.requestJSON("DELETE", `/api/v1/catalogue/assets/${assetId}`, undefined, options);
    return parseWith(CatalogueDeleteResponseSchema, body, "catalogue erasure");
  }

  /**
   * Draft a takedown notice for a copy found in the wild. A notice is drafted only
   * if the copy matches this account's catalogue; the answer is then
   * `READY_FOR_REVIEW`, a draft a named person must check and approve before anyone
   * sends it. Nothing is sent. A copy that does not match comes back `UNKNOWN` with
   * no notice.
   */
  async draftNotice(
    request: CatalogueNoticeRequest,
    options: RequestOptions = {},
  ): Promise<CatalogueNoticeResponse> {
    const parsed = CatalogueNoticeRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new CantiviaError(`invalid notice request: ${parsed.error.message}`);
    }
    const body = await this.requestJSON("POST", "/api/v1/catalogue/notice", parsed.data, options);
    return parseWith(CatalogueNoticeResponseSchema, body, "notice");
  }

  /**
   * Score a social post's spread with Titrate. No fact-check runs: the stream
   * carries one `titrate` event, or an `error` when Titrate is not enabled for the
   * account.
   *
   * `postUrl` is a bsky.app post link or an at:// post URI.
   */
  async *scorePostStream(postUrl: string, options: RequestOptions = {}): AsyncGenerator<StreamChunk> {
    const parsed = PostTitrateRequestSchema.safeParse({ postUrl, kind: "post" });
    if (!parsed.success) {
      throw new CantiviaError(`invalid Titrate post request: ${parsed.error.message}`);
    }
    yield* this.streamVerify(parsed.data, options);
  }

  /**
   * Score a social post's spread with Titrate and return its answer.
   *
   * The answer is often `scored: false`: most posts get no replies, and a post under
   * an hour old has not finished its window. Read `abstainReason`. Throws
   * `VerificationError` on an error event (including Titrate not being enabled),
   * or `CantiviaError` if the stream ends without an answer.
   */
  async scorePost(postUrl: string, options: RequestOptions = {}): Promise<Titrate> {
    let result: Titrate | undefined;
    for await (const chunk of this.scorePostStream(postUrl, options)) {
      if (chunk.type === "error") {
        throw new VerificationError(chunk.message, { requestId: chunk.requestId });
      }
      if (chunk.type === "titrate") {
        result = chunk.result;
      }
    }
    if (result === undefined) {
      throw new CantiviaError("post scoring stream ended without an answer");
    }
    return result;
  }

  /**
   * Rewrite a conversational follow-up ("what about in 2019?") into a standalone
   * claim, using the claims the conversation has already checked. Verify the
   * returned `claim`. When nothing could be rewritten, `resolved` is false and
   * `claim` is the follow-up unchanged.
   *
   * Pass earlier claims only, never their verdicts (at most 20).
   */
  async resolve(
    followUp: string,
    options: RequestOptions & { priorClaims?: string[] } = {},
  ): Promise<ResolveResult> {
    const parsed = ResolveRequestSchema.safeParse({ followUp, priorClaims: options.priorClaims });
    if (!parsed.success) {
      throw new CantiviaError(`invalid resolve request: ${parsed.error.message}`);
    }
    const body = await this.requestJSON("POST", "/api/v1/resolve", parsed.data, options);
    return parseWith(ResolveResultSchema, body, "resolve");
  }

  /**
   * Screen one manuscript's title and abstract for the writing style of paper-mill
   * products, and say whether a person should review it. It scores style, not
   * fraud: show the `caveats` with the `decision`. At least one of `title` and
   * `abstract` is required. `budget` is the share of submissions your team can
   * review (for example 0.01); the screen flags at that rate.
   */
  async screenManuscript(
    manuscript: PaperMillScreenRequest,
    options: RequestOptions = {},
  ): Promise<PaperMillScreenResult> {
    const parsed = PaperMillScreenRequestSchema.safeParse(manuscript);
    if (!parsed.success) {
      throw new CantiviaError(`invalid manuscript: ${parsed.error.message}`);
    }
    if (!parsed.data.title.trim() && !parsed.data.abstract.trim()) {
      throw new CantiviaError("invalid manuscript: a title or an abstract is required");
    }
    const body = await this.requestJSON("POST", "/api/v1/paper-mill/screen", parsed.data, options);
    return parseWith(PaperMillScreenResultSchema, body, "paper-mill screen");
  }

  /**
   * Submit up to 500 claims (or, with `kind: "article"`, article texts) to be
   * fact-checked in the background, and return the batch id at once. Read progress
   * with `getBatch`, or wait for the results with `waitForBatch`.
   *
   * `idempotencyKey` makes resubmitting safe: a submission sent again with the same
   * key returns the batch the first one created instead of running it twice.
   */
  async submitBatch(
    claims: string[],
    options: RequestOptions & { kind?: BatchRequest["kind"]; idempotencyKey?: string } = {},
  ): Promise<BatchAccepted> {
    const parsed = BatchRequestSchema.safeParse({ claims, kind: options.kind });
    if (!parsed.success) {
      throw new CantiviaError(`invalid batch: ${parsed.error.message}`);
    }
    const headers = options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : undefined;
    const body = await this.requestJSON("POST", "/api/v1/batch", parsed.data, { ...options, headers });
    return parseWith(BatchAcceptedSchema, body, "batch submission");
  }

  /**
   * Read a batch's progress and the results so far. Only the key that submitted a
   * batch can read it; any other id answers 404 (`NotFoundError`).
   */
  async getBatch(batchId: string, options: RequestOptions = {}): Promise<Batch> {
    // Checked before sending because it becomes part of the URL.
    if (!UUID.test(batchId)) {
      throw new CantiviaError("invalid batch id: expected the UUID submitBatch answered with");
    }
    const body = await this.requestJSON("GET", `/api/v1/batch/${batchId}`, undefined, options);
    return parseWith(BatchSchema, body, "batch");
  }

  /**
   * Wait for a batch to finish and return it. Reads the batch every 5 s
   * (`pollIntervalMs`) until it is `completed` or `failed`, calling `onProgress`
   * with every snapshot. A `completed` batch can still hold failed items: read each
   * item's `status` and `error`. A batch unfinished after `maxWaitMs` (default 60
   * minutes) throws `CantiviaError` naming its id; it keeps running, and `getBatch`
   * reads it on.
   */
  async waitForBatch(batchId: string, options: PollOptions<Batch> = {}): Promise<Batch> {
    const maxWaitMs = options.maxWaitMs ?? BATCH_MAX_WAIT_MS;
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const batch = await this.getBatch(batchId, options);
      options.onProgress?.(batch);
      if (batch.status === "completed" || batch.status === "failed") {
        return batch;
      }
      if (Date.now() >= deadline) {
        throw new CantiviaError(
          `batch ${batchId} did not finish within ${maxWaitMs}ms; read it on with getBatch`,
        );
      }
      await pause(options.pollIntervalMs ?? BATCH_POLL_INTERVAL_MS, options.signal);
    }
  }
}
