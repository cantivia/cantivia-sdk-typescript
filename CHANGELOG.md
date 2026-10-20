# Changelog

All notable changes to `@cantivia/sdk` are recorded here. The package follows
[Semantic Versioning](https://semver.org); while the version is 0.x, a minor release
may change the API.

## 0.1.0

First public release.

- `CantiviaClient` for Node 18+, Bun, Deno and edge runtimes, reading
  `CANTIVIA_API_KEY` and `CANTIVIA_BASE_URL` from the environment.
- Fact-checking: `verify`, `verifyArticle`, `verifyImage` and their streaming forms,
  and `resolve` for follow-up questions.
- The fact-checking methods, batches included, ship ahead of launch and are refused until then.
- Batch verification: `submitBatch`, `getBatch` and `waitForBatch`.
- Media forensics and the media catalogue: `verifyMedia`, `enrollMedia`,
  `startEnrollment`, `getEnrollmentJob`, `listCatalogue`, `deleteCatalogueAsset` and
  `draftNotice`.
- Titrate post scoring: `scorePost`.
- Paper-mill screening: `screenManuscript`.
- Account usage: `usage`.
- Automatic retries for requests that never reached the service (connection
  failures, 429 and 503), honouring `Retry-After`.
- An idle timeout that long streaming checks stay within.
- Stream event types this release does not know are skipped, and a value it does not
  know in a known field (a new verdict, status or reason) is kept as its raw string, so
  a newer API does not break it.
- One error class per HTTP status, each carrying the API's error `code`.
- Every error carries `requestId`, the id of the failed request, to quote to support.
