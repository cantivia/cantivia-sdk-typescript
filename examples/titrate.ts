// Score how a Bluesky post is spreading with Titrate.
//
//   CANTIVIA_API_KEY=... bun examples/titrate.ts https://bsky.app/profile/<handle>/post/<id>

import { CantiviaClient } from "@cantivia/sdk";

const postUrl = process.argv[2];
if (!postUrl) {
  console.error("usage: bun examples/titrate.ts <bsky.app post URL>");
  process.exit(2);
}
const client = new CantiviaClient();

const score = await client.scorePost(postUrl);
if (!score.scored) {
  // Most posts are not scored: most get no replies, and a young post's window is still open.
  console.log(`not scored: ${score.abstainReason}${score.detail ? ` (${score.detail})` : ""}`);
} else {
  console.log(score.isViral ? "likely to spread widely" : "unlikely to spread widely");
  console.log(`viral means a thread of ${score.viralThresholdSize} posts within ${score.horizonHours} h`);
  if (score.sizeRange) {
    const { low, high, level } = score.sizeRange;
    console.log(`expected final size: ${low} to ${high} posts (${Math.round(level * 100)}% range)`);
  }
}
