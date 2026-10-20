// Print this key's request counts and each product's allowance.
//
//   CANTIVIA_API_KEY=... bun examples/usage.ts

import { CantiviaClient } from "@cantivia/sdk";

const client = new CantiviaClient();

const usage = await client.usage();
console.log(`requests: ${usage.requests.today} today, ${usage.requests.month} this month`);
console.log(`rate limit: ${usage.rateLimit.remaining}/${usage.rateLimit.limit} per ${usage.rateLimit.windowSeconds} s`);
for (const product of usage.products) {
  console.log(`\n${product.product}: ${product.status}${product.tier ? ` (${product.tier})` : ""}`);
  for (const unit of product.units) {
    const over = unit.overage ? `, ${unit.overage} over` : "";
    console.log(`  ${unit.unit}: ${unit.used} of ${unit.allowance ?? "no allowance"}${over}`);
  }
}
