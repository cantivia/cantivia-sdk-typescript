// Fact-checking is coming soon: the API refuses this script until it launches.
// Submit a batch of claims, wait for it to finish, and print the verdicts.
//
//   CANTIVIA_API_KEY=... bun examples/batch.ts

import { CantiviaClient } from "@cantivia/sdk";

const client = new CantiviaClient();

const claims = [
  "The Eiffel Tower is in Berlin.",
  "Water boils at 100 degrees Celsius at sea level.",
  "The Great Wall of China is visible from the Moon with the naked eye.",
];

// Resubmitting with the same key returns this batch instead of running it twice.
const { batchId } = await client.submitBatch(claims, { idempotencyKey: `example-${Date.now()}` });
console.log(`submitted ${batchId}`);

const batch = await client.waitForBatch(batchId, {
  onProgress: (b) => console.log(`${b.status}: ${b.done + b.failed}/${b.total}`),
});
for (const item of batch.items) {
  console.log(item.status === "done" ? `- ${item.verdict}: ${item.claim}` : `- failed (${item.error}): ${item.claim}`);
}
