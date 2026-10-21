# Cantivia TypeScript SDK

Typed TypeScript and JavaScript client for the Cantivia API.

[![npm](https://img.shields.io/npm/v/@cantivia/sdk)](https://www.npmjs.com/package/@cantivia/sdk)
[![Node](https://img.shields.io/node/v/@cantivia/sdk)](https://www.npmjs.com/package/@cantivia/sdk)
[![Licence](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)

[Cantivia](https://cantivia.com) screens research manuscripts for paper-mill writing,
checks media for provenance, and scores how a social post is spreading. This library
gives TypeScript and JavaScript applications typed access to its REST API.

## Products

| Product | What it does | Method |
|---|---|---|
| Paper-mill screen | Reads a manuscript's title and abstract and says whether an integrity reviewer should look at it | `screenManuscript` |
| Media forensics | Checks an image, audio clip or video for C2PA provenance and for matches against media you enrolled | `verifyMedia` |
| Media catalogue | Enrols media you hold the rights to, and drafts takedown notices for copies found online | `enrollMedia`, `draftNotice` |
| Titrate | Gives an early warning on whether a Bluesky post is about to spread widely | `scorePost` |
| Fact-checking (coming soon) | A verdict, its reasoning and citations for a claim, article or image; refused with 402 `no_entitlement` until it launches | `verify`, `verifyArticle`, `verifyImage` |

## Install

```sh
bun add @cantivia/sdk
```

Runs unchanged in Node 18 or later, Bun, Deno and edge runtimes: anything with a global
`fetch` and Web Streams. TypeScript 5.5 or later for the types. The only dependency is
`zod`, and any npm-compatible package manager works.

## Quick start

Create an API key on the [Cantivia dashboard](https://app.cantivia.com) and put it in the
`CANTIVIA_API_KEY` environment variable; the client reads it from there. Keep the key on
a server: a browser bundle that contains it hands it to every visitor.

```ts
import { CantiviaClient } from "@cantivia/sdk";

const client = new CantiviaClient();

const screen = await client.screenManuscript({
  title: "MicroRNA-21 promotes proliferation and invasion of gastric cancer cells by targeting PTEN",
  abstract:
    "Objective: To investigate the role of miR-21 in gastric cancer. Methods: qRT-PCR, " +
    "CCK-8 and Transwell assays were performed. Results: miR-21 promoted invasion by targeting PTEN.",
  budget: 0.01, // your reviewers can read one submission in a hundred
});

console.log(screen.decision); // "review", "pass" or "unavailable"
for (const caveat of screen.caveats) console.log("note:", caveat);
```

The screen scores writing style, not misconduct, so show the caveats with the decision.
Long checks have a `*Stream` form that yields progress as it happens.

## Errors and retries

Every error the SDK throws is a `CantiviaError`; an error status from the API throws an
`APIStatusError` subclass carrying `status`, a machine-readable `code` and the
`requestId` to quote to support. The client retries, twice by default, only requests
that provably never reached the service (a failed connection, a 429 or a 503), never a
timeout or another 5xx, so a check is never run or billed twice.

## Documentation

- [API reference](api.md): every method, parameter, return type, error and option, with retries, timeouts and streaming
- [Examples](examples/): a runnable script for each product
- [Changelog](CHANGELOG.md): every release; the package follows [Semantic Versioning](https://semver.org), and while it is 0.x a minor release may break the API

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Report a vulnerability privately as described in [SECURITY.md](SECURITY.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
