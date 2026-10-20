// Fact-checking is coming soon: the API refuses this script until it launches.
// Fact-check a claim and print each stage as it arrives, including the live
// reasoning text.
//
//   CANTIVIA_API_KEY=... bun examples/stream.ts "Inflation in Ireland fell last month."

import { CantiviaClient } from "@cantivia/sdk";

const claim = process.argv[2] ?? "Inflation in Ireland fell to its lowest level in three years last month.";
const client = new CantiviaClient();

for await (const event of client.verifyStream(claim)) {
  switch (event.type) {
    case "search_complete":
      console.log(`[search] ${event.resultCount} results`);
      break;
    case "factcheck_thinking":
      process.stdout.write(event.delta);
      break;
    case "done":
      console.log(`\n\nverdict: ${event.result.verdict}`);
      console.log(event.result.reasoning);
      break;
    case "error":
      throw new Error(event.message);
  }
}
