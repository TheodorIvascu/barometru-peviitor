"use strict";
const analytics = require("./lib/analytics.js");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function timed(name, fn) {
  const t0 = Date.now();
  const result = await fn();
  const ms = Date.now() - t0;
  console.log(`\n=== ${name} (${ms} ms) ===`);
  console.log(JSON.stringify(result, null, 2));
  return { name, ms, result };
}

(async () => {
  const results = [];
  results.push(await timed("overview", analytics.overview));
  results.push(await timed("locationStats", analytics.locationStats));
  results.push(await timed("categories", analytics.categories));
  results.push(await timed("warnings", analytics.warnings));
  results.push(await timed("salaryStats", analytics.salaryStats));
  results.push(await timed("companyStats", analytics.companyStats));

  console.log("\n\n=== WARM PASS (should all be ~0-1ms, categories may still be method:rules if embeddings are still warming) ===");
  const warm = [];
  warm.push(await timed("overview#2", analytics.overview));
  warm.push(await timed("locationStats#2", analytics.locationStats));
  warm.push(await timed("categories#2", analytics.categories));
  warm.push(await timed("warnings#2", analytics.warnings));
  warm.push(await timed("salaryStats#2", analytics.salaryStats));
  warm.push(await timed("companyStats#2", analytics.companyStats));

  // Poll categories() until the background embeddings build finishes (or
  // give up after 6 minutes). This proves the background warm-up path
  // actually flips method:"rules" -> method:"embeddings" without any
  // caller ever blocking on it.
  console.log("\n\n=== POLLING categories() for embeddings warm-up ===");
  let finalCategories = null;
  const pollStart = Date.now();
  for (let i = 0; i < 72; i++) {
    const r = await timed(`categories#poll${i}`, analytics.categories);
    finalCategories = r.result;
    if (r.result.method === "embeddings") {
      console.log(`\nEmbeddings warm-up finished after ${Date.now() - pollStart} ms of polling.`);
      break;
    }
    await sleep(5000);
  }

  console.log("\n\n=== TIMING SUMMARY ===");
  for (const r of [...results, ...warm]) console.log(r.name.padEnd(20), r.ms, "ms");
  console.log("\nfinal categories method:", finalCategories && finalCategories.method);
})().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
