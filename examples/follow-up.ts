// Fact-checking is coming soon: the API refuses this script until it launches.
// Turn a follow-up question into a standalone claim, then fact-check it.
//
//   CANTIVIA_API_KEY=... bun examples/follow-up.ts

import { CantiviaClient } from "@cantivia/sdk";

const client = new CantiviaClient();

const priorClaims = ["Ireland's unemployment rate was 4.2% in 2024."];
const resolved = await client.resolve("and what was it in 2019?", { priorClaims });
if (resolved.resolved) console.log(`checking: ${resolved.claim}`);

const result = await client.verify(resolved.claim);
console.log(`${result.verdict}: ${result.reasoning}`);
