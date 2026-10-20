// Fact-checking is coming soon: the API refuses this script until it launches.
// Read the text in an image (a screenshot, meme or infographic) and fact-check it.
//
//   CANTIVIA_API_KEY=... bun examples/image.ts screenshot.png

import { readFile } from "node:fs/promises";

import { CantiviaClient } from "@cantivia/sdk";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun examples/image.ts <image file>");
  process.exit(2);
}
const client = new CantiviaClient();

const image = (await readFile(path)).toString("base64");
const result = await client.verifyImage(image);
console.log(`overall: ${result.overallVerdict} (${result.claimCount} claims)`);
for (const claim of result.claims) {
  console.log(`- ${claim.verdict}: ${claim.claim}`);
}
