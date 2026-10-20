// Fact-checking is coming soon: the API refuses this script until it launches.
// Fact-check every check-worthy claim in an article's text.
//
//   CANTIVIA_API_KEY=... bun examples/article.ts article.txt

import { readFile } from "node:fs/promises";

import { CantiviaClient } from "@cantivia/sdk";

const path = process.argv[2];
const text = path
  ? await readFile(path, "utf-8")
  : "The city council said it planted 10,000 trees in 2025, double the previous year. Officials also claimed air quality improved by 40%.";
const client = new CantiviaClient();

const article = await client.verifyArticle(text);
console.log(`overall: ${article.overallVerdict}`);
console.log(article.summary);
console.log(
  `${article.verifiedCount} of ${article.claimCount} claims settled, ${article.degradedCount} could not be checked\n`,
);
for (const claim of article.claims) {
  console.log(`- ${claim.verdict}: ${claim.claim}`);
}
