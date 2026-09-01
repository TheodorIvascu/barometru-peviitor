"use strict";
/**
 * tools/cor_bench.js - measure the COR matcher against the REAL title
 * distribution of the job core.
 *
 * Titles come from live Solr when it is reachable, otherwise from
 * cache/aggregate.json's `titleCounts` (a real scan of the same index, dated
 * inside the file - never synthetic).
 *
 *   node tools/cor_bench.js              full report
 *   node tools/cor_bench.js --top 60     show the 60 heaviest unmatched titles
 *   node tools/cor_bench.js --json out.json
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const cor = require(path.join(ROOT, "lib", "cor.js"));

async function titlesFromSolr() {
  const { Solr } = require(path.join(ROOT, "lib", "solr.js"));
  const solr = new Solr({ core: "job" });
  if (!(await solr.ping())) return null;
  const counts = new Map();
  let jobs = 0;
  for await (const d of solr.scan("*:*", "title", 2000)) {
    jobs++;
    if (!d.title) continue;
    const t = Array.isArray(d.title) ? d.title[0] : d.title;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return { counts, jobs, source: "solr (live)" };
}

function titlesFromCache() {
  const p = path.join(ROOT, "cache", "aggregate.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const counts = new Map(Object.entries(j.data.titleCounts));
  return { counts, jobs: j.data.jobs, source: "cache/aggregate.json @ " + j.generatedAt };
}

async function loadTitles(forceCache) {
  if (forceCache) return titlesFromCache();
  try {
    const live = await titlesFromSolr();
    if (live) return live;
  } catch { /* fall through */ }
  return titlesFromCache();
}

const TIERS = ["exact", "synonym", "alias", "phrase", "subset", "segment", "fuzzy", "unmatched"];
const zero = () => Object.fromEntries(TIERS.map((t) => [t, 0]));

function measure(counts, index, opts) {
  const tally = zero();
  const jobsBy = zero();
  const unmatched = [];
  const matchedSample = [];
  let jobs = 0, matchedJobs = 0;
  for (const [title, n] of counts) {
    jobs += n;
    const m = cor.matchTitle(title, index, opts);
    const how = cor.tierOf(m && m.how);
    tally[how]++;
    jobsBy[how] += n;
    if (!m) unmatched.push({ title, count: n });
    else { matchedJobs += n; matchedSample.push({ title, count: n, code: m.code, name: m.name, how: m.how }); }
  }
  unmatched.sort((a, b) => b.count - a.count);
  return { jobs, matchedJobs, pct: +(matchedJobs / jobs * 100).toFixed(2), tally, jobsBy, unmatched, matchedSample };
}

const V1 = require(path.join(__dirname, "cor_synonyms_v1.js"));
// step 0 = the module exactly as it shipped: v1 cleaning on, everything the
// residue taught us off
const S0 = { entities: false, noise: true, noise2: false, plural: false, phrase: false, subset: false, segment: false };
const on = (o) => ({ ...S0, ...o });

/**
 * Cumulative ladder. Step 0 rebuilds the matcher exactly as it shipped on
 * 2026-08-20 - old synonym table, old cleaning rules, no alias index, none of
 * the new tiers - so the baseline is reproduced from source rather than quoted
 * from memory. Each later row switches on exactly one thing.
 */
const LADDER = [
  ["0. matcher-ul livrat pe 2026-08-20", { v1: true, stages: S0 }],
  ["1. + tabel de sinonime corectat si extins", { noAlias: true, stages: S0 }],
  ["2. + alias din glosa in paranteza a COR", { stages: S0 }],
  ["3. + decodare entitati HTML", { stages: on({ entities: true }) }],
  ["4. + curatare zgomot extinsa (paranteze, tari, SIRUTA)", { stages: on({ entities: true, noise2: true }) }],
  ["5. + singular/plural ghidat de vocabularul COR", { stages: on({ entities: true, noise2: true, plural: true }) }],
  ["6. + fraza COR continua in titlu", { stages: { ...cor.STAGES, subset: false, segment: false } }],
  ["7. + subset de cuvinte in ordine (min. 3 cuvinte)", { stages: { ...cor.STAGES, segment: false } }],
  ["8. + segmentare pe / | , -", { stages: cor.STAGES }],
];

function ladder(counts) {
  console.log("");
  console.log("CE ADUCE FIECARE PAS (cumulativ, pe joburi)");
  console.log("  pas                                                     joburi      %      delta");
  let prev = null;
  const rows = [];
  for (const [label, cfg] of LADDER) {
    const idx = cor.loadCor(undefined, {
      synonymGroups: cfg.v1 ? V1 : undefined,
      noAlias: !!cfg.v1 || !!cfg.noAlias,
    });
    let matched = 0, total = 0;
    for (const [title, n] of counts) {
      total += n;
      if (cor.matchTitle(title, idx, { stages: cfg.stages })) matched += n;
    }
    const pct = +(matched / total * 100).toFixed(2);
    const delta = prev === null ? "" : (pct - prev >= 0 ? "+" : "") + (pct - prev).toFixed(2) + " pp";
    console.log("  " + label.padEnd(52) + String(matched).padStart(8) + "  " + (pct + "%").padStart(7) + "   " + delta.padStart(9));
    rows.push({ label, matched, pct });
    prev = pct;
  }
  return rows;
}

async function main() {
  const argv = process.argv.slice(2);
  const topN = argv.includes("--top") ? Number(argv[argv.indexOf("--top") + 1]) : 40;
  const { counts, jobs, source } = await loadTitles(argv.includes("--cache"));
  const index = cor.loadCor();
  const t0 = Date.now();
  const r = measure(counts, index);
  const ms = Date.now() - t0;

  console.log("sursa titluri : " + source);
  console.log("joburi        : " + jobs + "   titluri distincte: " + counts.size);
  console.log("timp match    : " + ms + " ms  (" + Math.round(counts.size / (ms / 1000)) + " titluri/s)");
  console.log("");
  console.log("MATCH RATE pe JOBURI  : " + r.matchedJobs + " / " + r.jobs + "  = " + r.pct + "%");
  const tPct = (n) => (n / counts.size * 100).toFixed(2) + "%";
  const jPct = (n) => (n / r.jobs * 100).toFixed(2) + "%";
  console.log("MATCH RATE pe TITLURI : " + (counts.size - r.tally.unmatched) + " / " + counts.size +
    "  = " + ((counts.size - r.tally.unmatched) / counts.size * 100).toFixed(2) + "%");
  console.log("");
  console.log("  tier        titluri            joburi");
  for (const k of TIERS) {
    console.log("  " + k.padEnd(11) + String(r.tally[k]).padStart(7) + " " + tPct(r.tally[k]).padStart(8) +
      "   " + String(r.jobsBy[k]).padStart(7) + " " + jPct(r.jobsBy[k]).padStart(8));
  }

  if (argv.includes("--ladder")) ladder(counts);

  if (topN > 0) {
    console.log("\nTOP " + topN + " TITLURI NEPOTRIVITE (dupa numar de joburi)");
    let cum = 0;
    r.unmatched.slice(0, topN).forEach((u, i) => {
      cum += u.count;
      console.log("  " + String(i + 1).padStart(3) + ". " + String(u.count).padStart(5) + "  " +
        (cum / r.jobsBy.unmatched * 100).toFixed(1).padStart(5) + "%  " + u.title);
    });
  }

  const jsonIdx = argv.indexOf("--json");
  if (jsonIdx >= 0) {
    const out = argv[jsonIdx + 1];
    fs.writeFileSync(out, JSON.stringify({
      source, jobs: r.jobs, distinctTitles: counts.size, matchedJobs: r.matchedJobs, pct: r.pct,
      tally: r.tally, jobsBy: r.jobsBy,
      unmatched: r.unmatched.slice(0, 3000),
      matchedSample: r.matchedSample,
    }), "utf8");
    console.log("\nscris: " + out);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
