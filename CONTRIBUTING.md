# Contributing

Thank you for helping improve the Cantivia TypeScript SDK. Issues and pull requests
are both welcome.

## Issues

Bug reports, questions and feature requests are welcome as GitHub issues. Include the
SDK version, your runtime and its version, and a minimal script that shows the problem.
Never paste an API key. Report security issues privately as described in
[SECURITY.md](SECURITY.md).

## Pull requests

Feel free to open a pull request: a bug fix, a clearer error message, a better
example, a missing type, a typo. For a larger change, open an issue first so we can
agree on the approach before you spend time on it.

Keep a change focused, add a test for it, and make sure the checks below pass.

This repository is published from Cantivia's internal source, so an accepted change is
applied there and arrives here in the next release. Your pull request is then closed
rather than merged, and the release notes credit you.

## Development

The SDK is developed with [Bun](https://bun.sh).

```sh
bun install
bun run typecheck   # the sources and the examples
bun test            # offline: every test mocks the API
bun run build       # writes dist/
```

Tests never call the live API. To try a change against it, run one of the scripts in
`examples/` with `CANTIVIA_API_KEY` set, for example `bun examples/paper-mill.ts`.

## Licence

By contributing you agree that your contribution is licensed under the Apache License,
Version 2.0, the licence of this project.
