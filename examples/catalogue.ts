// Enrol a file you hold the rights to into your account's catalogue, then list it.
//
//   CANTIVIA_API_KEY=... bun examples/catalogue.ts press-photo.jpg

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { CantiviaClient } from "@cantivia/sdk";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun examples/catalogue.ts <file>");
  process.exit(2);
}
const client = new CantiviaClient();

const media = (await readFile(path)).toString("base64");
const job = await client.enrollMedia([{ name: basename(path), media }], {
  onProgress: (j) => console.log(`${j.status}: ${j.completed}/${j.total}`),
});
for (const asset of job.assets) {
  console.log(`${asset.name}: ${asset.status}${asset.reason ? ` (${asset.reason})` : ""}`);
}

const catalogue = await client.listCatalogue();
console.log(`\nthe catalogue holds ${catalogue.gallerySize} of at most ${catalogue.maxAssets} assets`);
for (const asset of catalogue.assets) {
  console.log(`- ${asset.name} (${asset.modality}, enrolled ${asset.enrolledAt})`);
}
