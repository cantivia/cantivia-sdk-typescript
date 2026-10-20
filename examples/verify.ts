// Fact-checking is coming soon: the API refuses this script until it launches.
// Fact-check one claim and print the verdict, reasoning and citations.
//
//   CANTIVIA_API_KEY=... bun examples/verify.ts "The Eiffel Tower is in Berlin."

import { CantiviaClient, RateLimitError, VERDICT_LABELS } from "@cantivia/sdk";

const claim = process.argv[2] ?? "The Eiffel Tower is in Berlin.";
const client = new CantiviaClient();

try {
  const result = await client.verify(claim);
  if (result.degraded) {
    console.log("The check could not run to completion; try again shortly.");
  } else {
    console.log(`${VERDICT_LABELS[result.verdict] ?? result.verdict}: ${claim}\n`);
    console.log(result.reasoning, "\n");
    for (const citation of result.citations) {
      console.log(`- ${citation.url}\n  "${citation.quote}"`);
    }
  }
} catch (err) {
  if (err instanceof RateLimitError) {
    console.error(`Rate limited (${err.code}); retry after ${err.retryAfter ?? "a while"} s.`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
