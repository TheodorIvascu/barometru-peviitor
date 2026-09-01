#!/usr/bin/env node
"use strict";
/**
 * classify.js - writes DERIVED location fields, never touches `location` itself.
 *
 * Results are written to cache/locations.json, NOT to Solr. The peviitor_core
 * schema is the authority and this tool must never add fields to it - so the
 * derived data lives beside the index, keyed by job url:
 *
 *   { "<url>": { canonical: string[], kind: "fixed"|"country"|"international"|"junk", how: string } }
 *   verified / international / junk  booleans   -> kept for backwards compatibility
 *
 * The original `location` is left alone on purpose: rewriting it is a data fix,
 * and data fixes go through the review cart in the UI, not through this scan.
 *
 * `location` is text_general in peviitor's schema, so Solr faceting returns
 * tokens ("cluj", "napoca") rather than values. location_s is what makes the
 * locality analytics and the drill-down queries possible at all.
 *
 * Usage:  node classify.js [--limit N] [--dry]
 */
const path = require("path");
require(path.join(__dirname, "lib", "env.js")).load();
const fs = require("fs");
const { Solr } = require(path.join(__dirname, "lib", "solr.js"));
const { loadIndex, classify } = require(path.join(__dirname, "lib", "locations.js"));

const DRY = process.argv.includes("--dry");
const li = process.argv.indexOf("--limit");
const LIMIT = li > -1 ? parseInt(process.argv[li + 1], 10) : Infinity;
const BATCH = 1000;

/** "Romania" is a country, and a country IS a place - for a remote job it is
 *  the honest answer, not a defect. It is less precise than a locality, so it
 *  gets its own kind rather than being lumped in with genuine rubbish like
 *  "all" or "Nespecificat". */
const COUNTRY_RE = /^(remote\s*[-,]?\s*)?rom[aâă]nia(\s*\(?\s*remote\s*\)?)?$/i;
function isCountryLevel(raw) {
  const bare = String(raw == null ? "" : raw)
    .replace(/[ăâîșț]/g, (c) => ({ "ă": "a", "â": "a", "î": "i", "ș": "s", "ț": "t" }[c]))
    .replace(/\s+/g, " ").trim();
  return COUNTRY_RE.test(bare);
}

const fmt = (n) => n.toLocaleString("ro-RO");

(async () => {
  const t0 = Date.now();
  const index = loadIndex(__dirname);
  const solr = new Solr({ core: "job" });
  const total = await solr.count("*:*");
  console.log(`index: ${fmt(total)} joburi`);

  const stats = { scanned: 0, fixed: 0, international: 0, country: 0, junk: 0, changed: 0 };
  const byKind = { fixed: new Map(), international: new Map(), country: new Map(), junk: new Map() };
  const samples = { fixed: [], international: [], country: [], junk: [] };

  const derived = Object.create(null);

  for await (const d of solr.scan("*:*", "url,location")) {
    if (stats.scanned >= LIMIT) break;
    stats.scanned++;

    const before = Array.isArray(d.location) ? d.location : d.location ? [d.location] : [];
    const canon = [];
    let kind = "junk";
    let how = "empty";

    for (const loc of before) {
      const c = classify(loc, index);
      if (c.kind === "fixed") {
        kind = "fixed";
        how = c.how;
        if (c.value && !canon.includes(c.value)) canon.push(c.value);
      } else if (c.kind === "international" && kind !== "fixed") {
        kind = "international";
        how = c.how;
        if (c.value && !canon.includes(c.value)) canon.push(c.value);
      } else if (kind === "junk") {
        how = c.how;
      }
    }

    // country-level before junk: "Remote, Romania" is an answer, not rubbish
    if (kind === "junk" && before.some(isCountryLevel)) { kind = "country"; how = "nivel tara"; }

    stats[kind]++;
    const tally = byKind[kind];
    for (const v of canon.length ? canon : before.length ? before : ["(gol)"]) {
      tally.set(v, (tally.get(v) || 0) + 1);
    }
    if (samples[kind].length < 20) {
      samples[kind].push({ url: d.url, before, after: canon, how });
    }
    // did the canonical form differ from what is stored? that is the fix the
    // user will be asked to approve later in the cart.
    if (kind === "fixed" && JSON.stringify(before) !== JSON.stringify(canon)) stats.changed++;

    derived[d.url] = { canonical: canon, kind, how };

    if (stats.scanned % 10000 === 0) console.log(`  ${fmt(stats.scanned)}...`);
  }


  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== rezultat (${secs}s) ===`);
  console.log(`  scanate        : ${fmt(stats.scanned)}`);
  console.log(`  identificate   : ${fmt(stats.fixed)}  (${(stats.fixed / stats.scanned * 100).toFixed(2)}%)`);
  console.log(`  de corectat    : ${fmt(stats.changed)}  (difera de valoarea stocata)`);
  console.log(`  internationale : ${fmt(stats.international)}  (${(stats.international / stats.scanned * 100).toFixed(2)}%)`);
  console.log(`  nivel tara     : ${fmt(stats.country)}  (${(stats.country / stats.scanned * 100).toFixed(2)}%)`);
  console.log(`  junk           : ${fmt(stats.junk)}  (${(stats.junk / stats.scanned * 100).toFixed(2)}%)`);

  for (const k of ["fixed", "international", "country", "junk"]) {
    console.log(`\n--- top ${k} ---`);
    for (const [v, c] of top(byKind[k], 12)) console.log(`  ${String(c).padStart(6)}  ${v}`);
  }
  console.log("\n--- exemple junk ---");
  for (const s of samples.junk.slice(0, 10)) {
    console.log(`  ${JSON.stringify(s.before)}  [${s.how}]`);
  }

  const out = {
    at: new Date().toISOString(),
    seconds: Number(secs),
    stats,
    top: { fixed: top(byKind.fixed, 60), international: top(byKind.international, 60), country: top(byKind.country, 60), junk: top(byKind.junk, 60) },
    samples,
  };
  fs.writeFileSync(path.join(__dirname, "cache", "classify.json"), JSON.stringify(out, null, 2), "utf8");
  if (!DRY) {
    fs.writeFileSync(
      path.join(__dirname, "cache", "locations.json"),
      JSON.stringify({ at: out.at, count: stats.scanned, derived }),
      "utf8"
    );
  }
  console.log(`\n${DRY ? "DRY RUN - nimic scris." : "scris in Solr."}  raport: cache/classify.json`);
})().catch((e) => { console.error(e); process.exit(1); });
