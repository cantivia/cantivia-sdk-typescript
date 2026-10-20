// Run media forensics on a file and print each event as it arrives.
//
//   CANTIVIA_API_KEY=... bun examples/stream-media.ts clip.mp4 video video/mp4

import { readFile } from "node:fs/promises";

import { CantiviaClient } from "@cantivia/sdk";

const [path, modality = "image", mime] = process.argv.slice(2);
if (!path || (modality !== "image" && modality !== "audio" && modality !== "video")) {
  console.error("usage: bun examples/stream-media.ts <file> [image|audio|video] [mime type]");
  process.exit(2);
}
const client = new CantiviaClient();

const media = (await readFile(path)).toString("base64");
for await (const event of client.verifyMediaStream(media, modality, { mime })) {
  switch (event.type) {
    case "media_forensics":
      // "unknown" means no check found anything, not that the file is authentic.
      console.log(`verdict: ${event.result.verdict}`);
      for (const channel of event.result.channels) {
        console.log(`- ${channel.channel}: ${channel.verdict}. ${channel.detail}`);
      }
      break;
    case "media_done":
      console.log("done");
      break;
    case "error":
      throw new Error(event.message);
  }
}
