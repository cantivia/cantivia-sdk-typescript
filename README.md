# Cantivia TypeScript SDK

Cantivia checks images, audio and video for C2PA provenance and for matches against
media you have enrolled, scores how a social post is spreading, and screens research
manuscripts for paper-mill writing. Checking claims, articles and images against
evidence, with a verdict, the reasoning behind it and the sources it rests on, is
coming soon: see [Fact-checking (coming soon)](#fact-checking-coming-soon).

This library gives typed access to the Cantivia API from TypeScript and JavaScript.
It depends only on `zod` and the runtime's own `fetch`, so it runs unchanged in
Node 18+, Bun, Deno and edge runtimes.

The full method reference is in [api.md](api.md), and runnable scripts are in
[examples/](examples).

## Installation

```sh
bun add @cantivia/sdk
```

Any npm-compatible package manager works.

## Usage

Create an API key on the Cantivia dashboard and put it in the environment:

```sh
export CANTIVIA_API_KEY="ctva_..."
```

```ts
import { CantiviaClient } from "@cantivia/sdk";

const client = new CantiviaClient(); // reads CANTIVIA_API_KEY

const screen = await client.screenManuscript({
  title: "MicroRNA-21 promotes proliferation and invasion of gastric cancer cells by targeting PTEN",
  abstract:
    "Objective: To investigate the role of miR-21 in gastric cancer. Methods: qRT-PCR, CCK-8 and Transwell " +
    "assays were performed. Results: miR-21 was upregulated and promoted proliferation, migration and invasion " +
    "by targeting PTEN. Conclusion: miR-21 may be a novel therapeutic target.",
  budget: 0.01,
});

console.log(screen.decision); // "review", "pass" or "unavailable"
for (const caveat of screen.caveats) console.log("note:", caveat);
```

The screen reads a manuscript's title and abstract and says whether a person should
look at it. It scores writing style, not misconduct, so show the `caveats` with the
decision. `unavailable` means the screen could not run, and `error` says why.

`apiKey` and `baseUrl` can also be passed to the constructor; they default to
`CANTIVIA_API_KEY` and `CANTIVIA_BASE_URL` (then `https://api.cantivia.com`).

Keep the key on a server. A browser bundle that contains it hands it to every visitor.

### Streaming

Long-running checks have a streaming form that yields each stage as it happens, which
keeps them responsive and inside the request timeout. `verifyMediaStream` yields a
`media_forensics` event carrying the result, then `media_done`; `scorePostStream` yields
one `titrate` event carrying the answer. A failure arrives as an `error` event:

```ts
import { readFile } from "node:fs/promises";

const video = (await readFile("clip.mp4")).toString("base64");
for await (const event of client.verifyMediaStream(video, "video", { mime: "video/mp4" })) {
  if (event.type === "media_forensics") console.log("verdict:", event.result.verdict);
  if (event.type === "media_done") console.log("done");
  if (event.type === "error") throw new Error(event.message);
}
```

The events are a discriminated union: narrowing on `event.type` gives the exact
fields for that stage. Breaking out of the loop closes the connection. An event type
this version of the SDK does not know is skipped, so a newer API never breaks an older
release.

## Products

### Media forensics

Check an image, an audio clip or a video for C2PA provenance and for a match against
media your account has enrolled. The verdict is `synthetic` or `unknown`, never
"real": `unknown` means no check found anything, not that the file is authentic.

```ts
const video = (await readFile("clip.mp4")).toString("base64");
const forensics = await client.verifyMedia(video, "video", { mime: "video/mp4" });
console.log(forensics.verdict);
for (const channel of forensics.channels) {
  console.log(channel.channel, channel.verdict, "-", channel.detail);
  for (const caveat of channel.caveats) console.log("  ", caveat);
}
```

Show each channel's `detail`, `caveats` and `scopeCaveats` with the verdict.

### Media catalogue

Enrol media you hold the rights to. Later forensics checks from any of your account's
keys match copies of it, and no other account can see it.

```ts
const job = await client.enrollMedia([{ name: "press-photo.jpg", media: photo }], {
  onProgress: (j) => console.log(`${j.completed}/${j.total}`),
});
for (const asset of job.assets) console.log(asset.name, asset.status, asset.reason ?? "");

const catalogue = await client.listCatalogue();
await client.deleteCatalogueAsset(catalogue.assets[0].assetId);
```

`draftNotice` drafts a takedown notice for a copy found online, if it matches the
catalogue. Nothing is sent: the draft is for a person to review.

### Titrate: score a post's spread

Titrate gives an early warning on a Bluesky post that is about to spread widely. It
scores spread, not truth.

```ts
const score = await client.scorePost("https://bsky.app/profile/example.com/post/3k2abc");
if (score.scored) {
  console.log(score.isViral ? "likely to spread" : "unlikely to spread", `(threshold: ${score.viralThresholdSize} posts)`);
} else {
  console.log("not scored:", score.abstainReason, score.detail);
}
```

Most posts are not scored: most get no replies, and a post under an hour old has not
finished its observation window. Read `abstainReason`.

### Paper-mill screen

Screen a manuscript's title and abstract for the writing style of paper-mill
products. It answers `review` (a person should read it) or `pass`; it scores style,
not misconduct, so show its `caveats` with the decision.

```ts
const screen = await client.screenManuscript({ title, abstract, budget: 0.01 });
console.log(screen.decision);
for (const caveat of screen.caveats) console.log("  ", caveat);
```

`budget` is the share of submissions your team can review; the screen flags at that
rate.

### Usage

```ts
const usage = await client.usage();
console.log(usage.requests.month, usage.rateLimit.remaining);
for (const product of usage.products) {
  for (const unit of product.units) console.log(product.product, unit.unit, unit.used, "of", unit.allowance);
}
```

## Handling errors

Every error the SDK throws is a `CantiviaError`. When the API answers with an error
status, the error is an `APIStatusError` subclass carrying `status`, `code` (a stable
identifier to branch on), `message`, `retryAfter` (seconds, or `null`), `body` and
`requestId`:

```ts
import { APIConnectionError, RateLimitError, PaymentRequiredError } from "@cantivia/sdk";

try {
  await client.screenManuscript({ title, abstract });
} catch (err) {
  if (err instanceof RateLimitError && err.code === "monthly_quota_exceeded") {
    // The plan's allowance is used up; waiting will not help.
  } else if (err instanceof PaymentRequiredError) {
    // The account has no active plan for this product.
  } else if (err instanceof APIConnectionError) {
    // The API could not be reached, or the request timed out (APITimeoutError).
  } else {
    throw err;
  }
}
```

| status | error |
|---|---|
| 400 | `BadRequestError` |
| 401 | `AuthenticationError` |
| 402 | `PaymentRequiredError` |
| 403 | `PermissionDeniedError` |
| 404 | `NotFoundError` |
| 409 | `ConflictError` |
| 413 | `RequestTooLargeError` |
| 422 | `UnprocessableEntityError` |
| 429 | `RateLimitError` |
| 5xx | `InternalServerError` (503: `ServiceUnavailableError`) |
| no response | `APIConnectionError` (timeout: `APITimeoutError`) |

A check that runs but reports a failure partway through throws `VerificationError`
from `verify`, `verifyArticle`, `verifyImage`, `verifyMedia` and `scorePost`; the
streaming methods yield it as an `error` event instead. Invalid arguments throw
`CantiviaError` before any request is sent.

Every response carries a `request-id` header, and both `APIStatusError` and
`VerificationError` expose it as `requestId` (a streamed `error` event carries it too).
It is also the end of the error's `message`:

```
429 rate_limited: Rate limit exceeded. Retry in 5s. (request id req_8f14e45fceea467f9a1b2c3d4e5f6a7b)
```

Quote the request id when you contact support: it lets us find everything that
happened to that request.

## Retries

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

```ts
const client = new CantiviaClient({ maxRetries: 0 }); // never retry
await client.screenManuscript({ title, abstract }, { maxRetries: 5 }); // per call
```

## Timeouts

A request fails with `APITimeoutError` when it goes 600 s without data, by default. A
stream counts every event as data, so a long check that keeps streaming progress does
not time out. Timeouts are never retried.

```ts
const client = new CantiviaClient({ timeoutMs: 120_000 });
await client.usage({ timeoutMs: 5_000 }); // per call
```

The time allowed to open a connection is the runtime's own (10 seconds in Node).
To cancel a call, pass an `AbortSignal` as `signal`; the call then rejects with the
signal's reason, including while `enrollMedia` or `waitForBatch` waits between polls.

## Custom fetch

Pass `fetch` to the constructor to route requests through a proxy, add logging, or
mock the API in tests:

```ts
const client = new CantiviaClient({
  fetch: (url, init) => {
    console.log(init?.method, url);
    return fetch(url, init);
  },
});
```

## Fact-checking (coming soon)

Fact-checking is not yet available on public plans, and calls to it are refused with
402 `no_entitlement` until it launches. The methods are already in this SDK, so code
written against them keeps working when it does.

A refused call throws `PaymentRequiredError` with `code` set to `no_entitlement`, or,
on a stream, yields an `error` event saying fact-checking is unavailable.

### Fact-check a claim

```ts
import { CantiviaClient, VERDICT_LABELS } from "@cantivia/sdk";

const client = new CantiviaClient(); // reads CANTIVIA_API_KEY

const result = await client.verify(
  "The Health Service Executive said hospital waiting lists fell by 12% in the first quarter of 2026.",
);

console.log(VERDICT_LABELS[result.verdict] ?? result.verdict);
console.log(result.reasoning);
for (const citation of result.citations) {
  console.log(citation.url, "-", citation.quote);
}
```

Show the verdict, the reasoning and the citations. Every result also carries a
`confidence` number: it is an internal signal for programmatic use, not a
probability, and it should not be shown to end users.

When `result.degraded` is true, the check could not run to completion and the
verdict (`unverifiable`) is a fallback, not a judgment about the claim. Retry it
rather than showing it as an answer.

### Streaming a fact-check

A fact-check can take from a few seconds to several minutes, depending on the
claim. `verifyStream` yields each stage as it happens, which keeps long checks
responsive and inside the request timeout:

```ts
for await (const event of client.verifyStream("Inflation in Ireland fell to its lowest level in three years last month.")) {
  if (event.type === "search_complete") console.log(`found ${event.resultCount} sources`);
  if (event.type === "factcheck_thinking") process.stdout.write(event.delta);
  if (event.type === "done") console.log("\n", event.result.verdict);
  if (event.type === "error") throw new Error(event.message);
}
```

### Fact-check an article

Pass the article's text. The API splits it into check-worthy claims, checks each one,
and returns an overall verdict for the document. URLs are not fetched: a link is
checked as a string, not as the page behind it.

```ts
const article = await client.verifyArticle(articleText);
console.log(article.overallVerdict, article.summary);
console.log(`${article.verifiedCount} of ${article.claimCount} claims settled`);
for (const claim of article.claims) console.log(claim.verdict, "-", claim.claim);
```

`degradedCount` counts the claims that could not be checked at all, as opposed to
claims the evidence did not settle.

### Fact-check an image

Screenshots, memes and infographics: the image's text is read, then checked like an
article.

```ts
import { readFile } from "node:fs/promises";

const image = (await readFile("screenshot.png")).toString("base64");
const result = await client.verifyImage(image);
console.log(result.overallVerdict, result.claimCount);
```

### Batch verification

Check up to 500 claims in the background, then collect the results:

```ts
const { batchId } = await client.submitBatch(claims, { idempotencyKey: "import-2026-10-20" });
const batch = await client.waitForBatch(batchId, {
  onProgress: (b) => console.log(`${b.done + b.failed}/${b.total}`),
});
for (const item of batch.items) console.log(item.status, item.verdict ?? item.error, "-", item.claim);
```

Resending a submission with the same `idempotencyKey` returns the original batch
instead of running it twice.

### Follow-up questions

`resolve` turns a follow-up such as "what about 2019?" into a claim that stands on
its own, using the claims already checked in the conversation:

```ts
const resolved = await client.resolve("what about 2019?", {
  priorClaims: ["Ireland's inflation rate was 2.1% in 2024."],
});
const result = await client.verify(resolved.claim);
```

### What the verdicts mean

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

These are the verdicts today; treat any other value as unknown. A newer server can add
one, and this version passes it through as its raw string. `VERDICT_LABELS` maps each
one to a display label, and has none for a verdict this version does not know.

## Requirements

Node 18 or later, Bun, Deno, or any runtime with a global `fetch` and Web Streams.
TypeScript 5.5 or later for the type definitions.

## Versioning

The package follows [Semantic Versioning](https://semver.org). While the version is
0.x, a minor release may change the API; read the [changelog](CHANGELOG.md) before
upgrading.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a security issue, see
[SECURITY.md](SECURITY.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
