# API reference

Every method is on `CantiviaClient` and returns a promise (the `*Stream` methods
return an async iterator). Every method also takes the per-call options
`RequestOptions`:

| option | type | meaning |
|---|---|---|
| `signal` | `AbortSignal` | cancel the call, including a wait between polls; it rejects with the signal's reason |
| `timeoutMs` | `number` | milliseconds without data before `APITimeoutError` (default 600000) |
| `maxRetries` | `number` | retries for a request that never reached the service (default 2) |

Types are exported from `@cantivia/sdk` under the names below, each with a matching
zod schema (`VerificationResult` and `VerificationResultSchema`, and so on).

Where a response field lists its values below, it is one of these today; treat any
other value as unknown. A newer server can add a value, and this version passes it
through as its raw string, so such a field is typed `OpenEnum<T>`: the known values
`T` plus any other string.

## Client

```ts
new CantiviaClient(options?: CantiviaClientOptions)
```

| option | type | default |
|---|---|---|
| `apiKey` | `string` | `CANTIVIA_API_KEY` |
| `baseUrl` | `string` | `CANTIVIA_BASE_URL`, then `https://api.cantivia.com` |
| `timeoutMs` | `number` | `600000` (0 disables) |
| `maxRetries` | `number` | `2` (0 disables) |
| `headers` | `Record<string, string>` | none |
| `fetch` | `(url, init) => Promise<Response>` | the global `fetch` |

Without an API key, every method except `health` throws `CantiviaError` before
sending anything. Create a key on the Cantivia dashboard and put it in
`CANTIVIA_API_KEY`. Keep it on a server: a browser bundle that contains it hands it to
every visitor.

Pass `fetch` to route requests through a proxy, add logging, or mock the API in tests.

## Retries and timeouts

A request that never reached the service is retried up to 2 times: a connection that
could not be opened (refused, DNS failure, connect timeout), a 429, or a 503. The SDK
waits as long as the API's `Retry-After` asks (up to 60 seconds), and otherwise backs
off exponentially from 0.5 s to at most 8 s, with jitter.

Once a request has been sent it is never retried: not after a timeout, a reset or
dropped connection, any other 5xx, or a stream that has started, because the service
may already be working on the request and a second attempt would run, and bill, it
twice. The runtime must say why a connection failed for the SDK to know it was never
made: Node and Bun do; browsers and Deno do not, so there a connection error is not
retried.

A request fails with `APITimeoutError` when it goes `timeoutMs` (600 s by default)
without data. A stream counts every event as data, so a long check that keeps
streaming progress does not time out. Timeouts are never retried. The time allowed to
open a connection is the runtime's own (10 seconds in Node). To cancel a call, pass an
`AbortSignal` as `signal`.

```ts
const client = new CantiviaClient({ maxRetries: 0, timeoutMs: 120_000 });
await client.usage({ maxRetries: 5, timeoutMs: 5_000 }); // per call
```

## Streaming

The `*Stream` methods yield each stage as it happens, which keeps long checks
responsive and inside the request timeout. `StreamChunk` is a union discriminated by
`type`: narrowing on `event.type` gives the exact fields for that stage. A check that
fails partway through yields an `error` event (`message`, `requestId`) instead of
throwing. Breaking out of the `for await` loop closes the connection. An event type this
version does not know is skipped, so a newer API never breaks an older release.

## Media forensics

### `verifyMedia(media, modality, options?) => Promise<MediaForensicsResult>`

Check an image, audio clip or video for provenance and for a match against the
account's catalogue.

- `media: string`, base64, up to 8,000,000 characters.
- `modality: "image" | "audio" | "video"`.
- `options.mime: string`, the file's media type (audio and video).

`MediaForensicsResult`: `verdict` (`synthetic` or `unknown`, never "real"), `method`,
`channels` (each with `channel`, `verdict`, `scope`, `caveats`, `detail`,
`scopeCaveats`, `coverageValid`, `gradeCeiling`, `gallerySize` and `evidence`),
`excised`, `alpha`, `unavailable` (`{ channel, reason }[]`, channels that could not
run), and `combinedP` and each channel's `pValue` (calibration signals; do not show
them). `unknown` means no check found anything, not that the file is authentic. Show
each channel's `detail`, `caveats` and `scopeCaveats` with the verdict.

### `verifyMediaStream(media, modality, options?) => AsyncGenerator<StreamChunk>`

Yields `media_forensics` then `media_done`, or `error`.

`verifyMediaStream` with modality `"image"` runs forensics alone on an image, and so does
`verifyImageStream` with `forensicsOnly: true`: both yield `media_forensics` then
`media_done`, with no text reading and no fact-check.

## Media catalogue

### `enrollMedia(assets, options?) => Promise<CatalogueEnrollJob>`

Enrol media you hold the rights to, and wait for the job to finish. Later forensics
checks from any of your account's keys match copies of it, and no other account can see
it.

- `assets: { name: string; media: string }[]`, 1 to 10, `media` in base64.
- `options.source` (default `"api"`), `options.pollIntervalMs` (default 2000),
  `options.maxWaitMs` (default 600000), `options.onProgress(job)`.

`CatalogueEnrollJob`: `jobId`, `status` (`queued`, `running`, `done` or `failed`),
`total`, `completed`, `assets` (each `name`, `assetId`, `status` and `reason`),
`gallerySize`, `maxAssets`, `receipts`, `error`.

### `startEnrollment(assets, options?) => Promise<CatalogueEnrollJob>`

Submit an enrolment and return the job without waiting.

### `getEnrollmentJob(jobId, options?) => Promise<CatalogueEnrollJob>`

Read an enrolment job. A job expires an hour after it finishes (`NotFoundError`).

### `listCatalogue(options?) => Promise<CatalogueListResponse>`

`CatalogueListResponse`: `assets` (each `assetId`, `name`, `modality`, `enrolledAt`,
`source`, `bytesLen`), `gallerySize`, `maxAssets`. Metadata only; the uploaded bytes
are never kept.

### `deleteCatalogueAsset(assetId, options?) => Promise<CatalogueDeleteResponse>`

Erase one asset. `assetId` is the 64-character hex SHA-256 `listCatalogue` reports.

### `draftNotice(request, options?) => Promise<CatalogueNoticeResponse>`

Draft a takedown notice for a copy found online, if it matches the catalogue. Nothing
is sent: the draft is for a person to review.

- `request: CatalogueNoticeRequest`: `name`, `media` (base64), `infringingUrl`,
  `host`, and `complainant` (`name`, `organisation`, `email`, `address`).

`CatalogueNoticeResponse`: `outcome` (`MATCH` or `UNKNOWN`), `status`
(`READY_FOR_REVIEW` or `null`), `notice`, `noticeText`, `detail`.

## Titrate

### `scorePost(postUrl, options?) => Promise<Titrate>`

Score a Bluesky post's spread. `postUrl` is a bsky.app post link or an at:// URI.

It is an early warning on a post that is about to spread widely, and scores spread, not
truth. Most posts are not scored: most get no replies, and a post under an hour old has
not finished its observation window. Read `abstainReason`.

`Titrate`: `scored`, `abstainReason` (why it was not scored), `detail`, `platform`,
`postUri`, `isViral`, `viralThresholdSize`, `horizonHours`, `sizeRange`
(`{ low, high, level }`), `observedNodes`, `nodesInWindow`, `elapsedHours`,
`extrapolated`, `decisionThreshold`, `model`, `artifactSha256` and
`artifactFormatVersion` (which version of the scorer answered), and `probability` (a
calibration signal; do not show it). `platform` is `"bluesky"` for every scored post
today; `"reddit"` is reserved. `detail` explains `abstainReason` in words.

### `scorePostStream(postUrl, options?) => AsyncGenerator<StreamChunk>`

Yields one `titrate` event, or `error`.

## Paper-mill screen

### `screenManuscript(manuscript, options?) => Promise<PaperMillScreenResult>`

Screen a manuscript for the writing style of paper-mill products. It answers `review`
(a person should read it) or `pass`; it scores style, not misconduct, so show its
`caveats` with the decision. `unavailable` means the screen could not run, and `error`
says why.

- `manuscript.title: string` (up to 2,000 characters) and `manuscript.abstract:
  string` (up to 20,000); at least one must hold text, or the call throws
  `CantiviaError` before sending.
- `manuscript.budget: number` in (0, 1]: the share of submissions your team can
  review.

`PaperMillScreenResult`: `decision` (`review`, `pass` or `unavailable`), `score`,
`band`, `precision`, `precisionInterval`, `evidence` (`[term, weight][]`), `caveats`,
`model` (which version of the screen answered: `cohort`, the collection it was
trained on; `trainedThrough`, the last publication year in it; `trainedOn`, counts
describing it), `error`.

## Account

### `usage(options?) => Promise<Usage>`

`Usage`: `keyId`, `requests` (`window`, `today`, `month`), `rateLimit` (`limit`,
`remaining`, `windowSeconds`), `verdicts` (counts by verdict), `latencyMs` (`p50`,
`p95`, `samples`), and `products` (each `product`, `status`, `tier`, `pilotEndsAt`,
and `units`: `unit`, `used`, `allowance`, `overage`). The request and latency counts
are for the calling key and approximate; `products` is exact and covers the whole
account.

### `health(options?) => Promise<Record<string, unknown>>`

Check that the API is reachable. Needs no API key.

## Errors

| error | when |
|---|---|
| `CantiviaError` | base class; also invalid arguments and unexpected responses |
| `APIError` | base class for API failures |
| `APIConnectionError` | no response: connection refused or reset, DNS failure (retried only when the connection was never made) |
| `APITimeoutError` | no data within `timeoutMs` |
| `APIStatusError` | an error status; has `status`, `code`, `message`, `retryAfter`, `body`, `headers`, `requestId` |
| `BadRequestError` | 400 |
| `AuthenticationError` | 401 |
| `PaymentRequiredError` | 402 |
| `PermissionDeniedError` | 403 |
| `NotFoundError` | 404 |
| `ConflictError` | 409 |
| `RequestTooLargeError` | 413 |
| `UnprocessableEntityError` | 422 |
| `RateLimitError` | 429 |
| `InternalServerError` | 5xx |
| `ServiceUnavailableError` | 503 |
| `VerificationError` | a check reported an error partway through; has `requestId` |

`code` is a stable identifier to branch on, and `retryAfter` is in seconds, or `null`.
A `RateLimitError` with `code` `monthly_quota_exceeded` means the plan's allowance is
used up, and waiting will not help. A `PaymentRequiredError` means the account has no
active plan for the product.
Invalid arguments throw `CantiviaError` before any request is sent.

`VerificationError` is thrown by `verify`, `verifyArticle`, `verifyImage`,
`verifyMedia` and `scorePost` when a check runs but reports a failure partway through;
the streaming methods yield it as an `error` event instead.

`requestId` is the id the API gave the request, read from the `request-id` response
header (or the error body's `request_id`), and `null` when the response had none. Both
errors' `message` ends with it, and a streamed `error` event carries it as `requestId`:

```
429 rate_limited: Rate limit exceeded. Retry in 5s. (request id req_8f14e45fceea467f9a1b2c3d4e5f6a7b)
```

Quote the request id when you contact support: it lets us find everything that happened
to that request.

## Helpers

- `parseChunk(data: string) => StreamChunk | null`: parse one server-sent event
  payload. It returns `null` for an event type this version does not know, and the
  streaming methods skip those, so a newer API never breaks an older release.
- `parseUsage(json: unknown) => Usage`: parse a usage response.
- `VERSION`, `DEFAULT_BASE_URL`, `DEFAULT_TIMEOUT_MS`, `DEFAULT_MAX_RETRIES`, and the
  `MIN_*` and `MAX_*` input limits.

## Fact-checking (coming soon)

Fact-checking is not yet available on public plans, and calls to it are refused with
402 `no_entitlement` until it launches. The methods are already in the SDK, so code
written against them keeps working when it does. A refused call throws
`PaymentRequiredError` with `code` set to `no_entitlement`, or, on a stream, yields an
`error` event saying fact-checking is unavailable.

Show the verdict, the reasoning and the citations. When `degraded` is true, the check
could not run to completion and the verdict (`unverifiable`) is a fallback, not a
judgment about the claim: retry it rather than showing it as an answer. A fact-check can
take from a few seconds to several minutes, depending on the claim; `verifyStream`
yields each stage as it happens.

### `verify(claim, options?) => Promise<VerificationResult>` (coming soon)

Fact-check one claim and return its verdict, reasoning and citations.

- `claim: string`, 1 to 50,000 characters.
- `options: VerifyOptions`: `language` (default `"en"`), `priority` (`"standard"` or
  `"high"`), `postUrl` (the Bluesky post the claim came from; the stream then also
  carries a `titrate` event), and the request options.
- Throws `VerificationError` when the check reports an error.

`VerificationResult`: `claim`, `verdict` (`Verdict`), `reasoning`, `citations`
(`{ url, quote }[]`), `sources` (URLs found, optional), `cacheHit`, `route`,
`processingMs`, `degraded` (optional; true when the verdict is a fallback),
`usage` (optional tokens consumed: `totalInputTokens`, `totalOutputTokens`, and
`byModel`, a breakdown under opaque keys that may change), and `confidence` (a
calibration signal for programmatic use; not a probability, do not show it to end
users).

### `verifyStream(claim, options?) => AsyncGenerator<StreamChunk>` (coming soon)

The streaming form of `verify`. Yields `routing`, `cache_result`, `search_complete`,
`factcheck_thinking` (live reasoning text), `factcheck_complete`,
`reasoning_complete`, the debate events (`debate_decomposed`, `debate_round`,
`debate_argument`) when the claim is debated, `titrate` when `postUrl` was given, and
finally `done` (carrying the `VerificationResult`) or `error`.

### `verifyArticle(article, options?) => Promise<ArticleVerificationResult>` (coming soon)

Split a document's text into check-worthy claims, check each, and return the
aggregate. URLs are not fetched.

`ArticleVerificationResult`: `overallVerdict`, `summary`, `claimCount`,
`verifiedCount` (claims with a settled verdict), `degradedCount` (claims that could
not be checked), `extractionMethod`, `claims` (`VerificationResult[]`),
`processingMs`, and `overallConfidence` (a calibration signal; do not show it).

### `verifyArticleStream(article, options?) => AsyncGenerator<StreamChunk>` (coming soon)

Yields `claims_extracted`, a `claim_verified` per claim (`index`, `total`, `result`),
then `article_done` or `error`.

### `verifyImage(image, options?) => Promise<ArticleVerificationResult>` (coming soon)

Read the text in an image (a screenshot, meme or infographic) and check it like an
article. `image` is base64 (a `data:` URI prefix is accepted), up to 8,000,000
characters.

### `verifyImageStream(image, options?) => AsyncGenerator<StreamChunk>` (coming soon)

Yields `ocr_complete` (`textChars`, `language`), then the article events. With
`forensicsOnly: true`, runs media forensics alone and yields `media_forensics`
then `media_done`; that mode is available today.

### `resolve(followUp, options?) => Promise<ResolveResult>` (coming soon)

Rewrite a conversational follow-up, such as "what about 2019?", into a claim that
stands on its own, using the claims already checked in the conversation.

- `followUp: string`, 1 to 4,000 characters.
- `options.priorClaims: string[]`, the claims already checked (at most 20; never
  their verdicts).

`ResolveResult`: `claim` (the text to verify), `resolved` (false when nothing was
rewritten; `claim` is then the follow-up unchanged), `method`.

### Batch verification

#### `submitBatch(claims, options?) => Promise<BatchAccepted>` (coming soon)

Queue up to 500 claims for background checking and return at once.

- `claims: string[]`, 1 to 500, each non-empty and at most 10,000 characters.
- `options.kind`: `"claim"` (default) or `"article"`.
- `options.idempotencyKey: string`: resending with the same key returns the original
  batch instead of running it twice. The same key with different claims throws
  `UnprocessableEntityError` (`code: "idempotency_key_reused"`).

`BatchAccepted`: `batchId`, `total`, `status`.

#### `getBatch(batchId, options?) => Promise<Batch>` (coming soon)

Read a batch's progress and results. Only the submitting key can read it.

`Batch`: `batchId`, `status` (`queued`, `running`, `completed` or `failed`), `total`,
`pending`, `done`, `failed`, `createdAt`, `finishedAt` (or `null`), and `items`.
Each `BatchItem`: `idx`, `claim`, `status` (`pending`, `done` or `failed`), and once
done `verdict`, `reasoning`, `citations`, `degraded`, `processingMs` and
`confidence` (a calibration signal; do not show it), or `error` when it failed.

#### `waitForBatch(batchId, options?) => Promise<Batch>` (coming soon)

Poll `getBatch` until the batch is `completed` or `failed`.

- `options.pollIntervalMs` (default 5000), `options.maxWaitMs` (default 3,600,000),
  `options.onProgress(batch)` called with every snapshot.
- Throws `CantiviaError` naming the batch if it is still running after `maxWaitMs`;
  the batch keeps running and `getBatch` reads it on.

### Verdicts

| verdict | what it means |
|---|---|
| `true` | every material element is affirmed by the evidence |
| `mostly_true` | accurate in substance; a peripheral detail is off |
| `partially_true` | some load-bearing elements hold, others do not |
| `misleading` | technically accurate, and still leaves a false impression |
| `mostly_fake` | the core assertion fails; something incidental survives |
| `fake` | the core assertion is contradicted by the evidence |
| `unverifiable` | the evidence does not settle it, including claims not yet knowable |
| `not_a_claim` | the input was not a checkable claim (a greeting, a question) |

These are the values of `Verdict` today; treat any other value as unknown.
`VERDICT_LABELS` maps each to a display label (`VERDICT_LABELS[v] ?? v` for one this
version does not know).
