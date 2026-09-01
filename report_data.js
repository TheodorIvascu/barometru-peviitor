"use strict";
const fs = require("fs");
const path = require("path");
const { Solr } = require("./lib/solr.js");

/** Gather everything the report needs, live from Solr + the last run log. */
async function gather() {
  const solr = new Solr();
  const t0 = Date.now();
  const run = fs.existsSync(path.join(__dirname, "last_run.json"))
    ? JSON.parse(fs.readFileSync(path.join(__dirname, "last_run.json"), "utf8"))
    : null;

  const total = await solr.count("*:*");
  const fields = (await solr.fields()).map((f) => f.name);
  const uniqueKey = await solr.uniqueKey();
  const have = new Set(fields);

  const counts = {
    total,
    verified: have.has("verified") ? await solr.count("verified:true") : 0,
    unverified: have.has("verified") ? await solr.count("verified:false") : 0,
    international: have.has("international") ? await solr.count("international:true") : 0,
    junk: have.has("junk") ? await solr.count("junk:true") : 0,
  };

  const coverage = [];
  for (const f of ["url", "title", "company", "cif", "location", "tags", "workmode", "salary"]) {
    coverage.push({ field: f, n: await solr.count(f + ":*"), total });
  }

  const groupBy = async (q) => {
    const m = new Map();
    for await (const d of solr.scan(q, "location")) {
      const v = (Array.isArray(d.location) ? d.location : [d.location]).join(" | ") || "(empty)";
      m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
  };

  const intl = have.has("international") ? await groupBy("international:true") : [];
  const junk = have.has("junk") ? await groupBy("junk:true") : [];

  const mv = new Map();
  for await (const d of solr.scan("verified:true", "location")) {
    for (const v of (Array.isArray(d.location) ? d.location : [d.location])) mv.set(v, (mv.get(v) || 0) + 1);
  }
  const verifiedTop = [...mv.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));

  const seen = new Set();
  const rewrites = [];
  const catalogPath = path.join(__dirname, "rewrite_catalog.json");
  const catalog = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, "utf8")) : [];
  for (const f of catalog.concat((run && run.fixes) || [])) {
    const k = JSON.stringify(f.before) + JSON.stringify(f.after);
    if (seen.has(k)) continue;
    seen.add(k);
    rewrites.push(f);
  }

  return {
    generatedAt: new Date().toISOString(),
    gatherMs: Date.now() - t0,
    solrUrl: solr.url, uniqueKey, fieldCount: fields.length,
    counts, coverage, intl, junk, verifiedTop, verifiedDistinct: mv.size, rewrites, run,
  };
}
module.exports = { gather };
