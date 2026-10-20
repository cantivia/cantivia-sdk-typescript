// Screen a manuscript's title and abstract for paper-mill writing.
//
//   CANTIVIA_API_KEY=... bun examples/paper-mill.ts

import { CantiviaClient } from "@cantivia/sdk";

const client = new CantiviaClient();

const screen = await client.screenManuscript({
  title: "MicroRNA-21 promotes proliferation and invasion of gastric cancer cells by targeting PTEN",
  abstract:
    "Objective: To investigate the role of miR-21 in gastric cancer. Methods: qRT-PCR, CCK-8 and Transwell " +
    "assays were performed. Results: miR-21 was upregulated and promoted proliferation, migration and invasion " +
    "by targeting PTEN. Conclusion: miR-21 may be a novel therapeutic target.",
  // The share of submissions the editorial office can review.
  budget: 0.05,
});

console.log(`decision: ${screen.decision}`);
if (screen.error) console.log(`(${screen.error})`);
for (const [term, weight] of screen.evidence.slice(0, 5)) console.log(`- ${term} (${weight.toFixed(3)})`);
for (const caveat of screen.caveats) console.log(`note: ${caveat}`);
