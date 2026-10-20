// Run media forensics on an image, audio clip or video.
//
//   CANTIVIA_API_KEY=... bun examples/media.ts clip.mp4 video video/mp4

import { readFile } from "node:fs/promises";

import { CantiviaClient } from "@cantivia/sdk";

const [path, modality = "image", mime] = process.argv.slice(2);
if (!path || (modality !== "image" && modality !== "audio" && modality !== "video")) {
  console.error("usage: bun examples/media.ts <file> [image|audio|video] [mime type]");
  process.exit(2);
}
const client = new CantiviaClient();

const media = (await readFile(path)).toString("base64");
const result = await client.verifyMedia(media, modality, { mime });

// "unknown" means no check found anything, not that the file is authentic.
console.log(`verdict: ${result.verdict}`);
for (const channel of result.channels) {
  console.log(`\n${channel.channel}: ${channel.verdict}`);
  console.log(`  ${channel.detail}`);
  for (const caveat of channel.caveats) console.log(`  - ${caveat}`);
}
for (const skipped of result.unavailable) {
  console.log(`\n${skipped.channel} did not run: ${skipped.reason}`);
}
