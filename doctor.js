#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const { Solr } = require("./lib/solr.js");
const { loadIndex, classify } = require("./lib/locations.js");
const { Progress } = require("./lib/progress.js");
const { gather } = require("./report_data.js");
const { printReport } = require("./report_text.js");
const { renderHtml } = require("./report_html.js");
const { runFlow } = require("./run_flow.js");

const HERE = __dirname;
const argv = process.argv.slice(2);
const cmd = argv[0] || "help";
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : d; };

const solr = new Solr();
const fmt = (n) => n.toLocaleString("en-US");
const pct = (n, t) => (t ? ((n / t) * 100).toFixed(1) + "%" : "0%");
const line = (c) => console.log((c || "-").repeat(72));

async function requireSolr() {
  if (!(await solr.ping())) {
    console.error("Solr is not reachable at " + solr.url);
    console.error("  try: docker start peviitor-solr");
    process.exit(1);
  }
}
async function health() {
  await requireSolr();
  const t0 = Date.now();
  line("=");
  console.log("SOLR HEALTH CHECK   " + solr.url);
  line("=");

  const uk = await solr.uniqueKey();
  const fields = await solr.fields();
  const total = await solr.count("*:*");

  console.log("");
  console.log("INDEX");
  console.log("  core            : " + solr.core);
  console.log("  uniqueKey       : " + uk);
  console.log("  fields defined  : " + fields.length);
  console.log("  documents       : " + fmt(total));

  console.log("");
  console.log("FIELD COVERAGE (docs that actually carry the field)");
  const names = ["url", "title", "company", "cif", "location", "tags", "workmode", "salary", "date", "status"];
  for (const f of names) {
    const n = await solr.count(f + ":*");
    const flag = n === total ? "OK  " : n === 0 ? "NONE" : "PART";
    console.log("  " + flag + " " + f.padEnd(10) + fmt(n).padStart(9) + "  " + pct(n, total).padStart(7));
  }

  const defined = new Set(fields.map((f) => f.name));
  console.log("");
  console.log("DATA QUALITY");
  if (defined.has("verified")) {
    const v = await solr.count("verified:true");
    const nv = await solr.count("verified:false");
    const none = total - v - nv;
    console.log("  verified true    : " + fmt(v).padStart(9) + "  " + pct(v, total));
    console.log("  verified false   : " + fmt(nv).padStart(9) + "  " + pct(nv, total));
    if (none > 0) console.log("  never checked    : " + fmt(none).padStart(9) + "  " + pct(none, total));
  } else {
    console.log("  verified      : field not present (run normalize --apply)");
  }
  for (const f of ["international", "junk"]) {
    if (defined.has(f)) {
      const n = await solr.count(f + ":true");
      console.log("  " + f.padEnd(16) + " : " + fmt(n).padStart(9) + "  " + pct(n, total));
    } else {
      console.log("  " + f.padEnd(16) + " : field not present");
    }
  }

  console.log("");
  console.log("INTEGRITY");
  const noUrl = await solr.count("-url:*");
  const noTitle = await solr.count("-title:*");
  const noCompany = await solr.count("-company:*");
  const noLoc = await solr.count("-location:*");
  console.log("  missing url      : " + fmt(noUrl) + (noUrl ? "   <-- breaks the uniqueKey" : ""));
  console.log("  missing title    : " + fmt(noTitle));
  console.log("  missing company  : " + fmt(noCompany));
  console.log("  missing location : " + fmt(noLoc));

  console.log("");
  console.log("TOP COMPANIES");
  for (const f of await solr.facet("company", "*:*", 8)) {
    console.log("  " + fmt(f.count).padStart(7) + "  " + f.value);
  }

  console.log("");
  console.log("checked in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
}
async function normalize(opts) {
  await requireSolr();
  const APPLY = opts && typeof opts.apply === "boolean" ? opts.apply : has("--apply");
  const LIMIT = parseInt(val("--limit", "0"), 10) || Infinity;
  const t0 = Date.now();

  line("=");
  console.log("LOCATION NORMALIZER   " + (APPLY ? "[APPLY - writes to Solr]" : "[DRY RUN - no writes]"));
  line("=");

  const index = loadIndex(HERE);
  console.log("official localities : " + fmt(index.localities) + " + " + index.counties + " counties  (loaded in " + index.ms + "ms)");

  const total = await solr.count("*:*");
  const okBefore = await solr.count("verified:true");
  console.log("");
  console.log("jobs in Solr        : " + fmt(total));
  console.log("  already verified  : " + fmt(okBefore) + "   -> SKIPPED");
  console.log("  to analyse        : " + fmt(total - okBefore));

  const defined = new Set((await solr.fields()).map((f) => f.name));
  for (const f of ["verified", "international", "junk"]) {
    if (defined.has(f)) continue;
    if (!APPLY) { console.log("  schema: " + f + " missing (would be created)"); continue; }
    await solr.addField(f);
    console.log("  schema: created field " + f);
  }

  const stats = { scanned: 0, fixed: 0, changed: 0, confirmed: 0, international: 0, junk: 0 };
  const fixes = [], intl = [], junk = [];
  let pending = [];
  const tScan = Date.now();
  const q = defined.has("verified") ? "-verified:true" : "*:*";
  const target = Math.min(LIMIT, total - okBefore);
  console.log("");
  const bar = new Progress(target, "analysing");

  for await (const d of solr.scan(q, "url,location")) {
    if (stats.scanned >= LIMIT) break;
    stats.scanned++;
    const before = Array.isArray(d.location) ? d.location : d.location ? [d.location] : [];
    const out = [];
    let kind = "junk", how = "empty";

    for (const loc of before) {
      const c = classify(loc, index);
      if (c.kind === "fixed") { kind = "fixed"; how = c.how; if (!out.includes(c.value)) out.push(c.value); }
      else if (c.kind === "international" && kind !== "fixed") { kind = "international"; how = c.how; if (c.value && !out.includes(c.value)) out.push(c.value); }
      else if (kind === "junk") how = c.how;
    }

    const upd = { url: d.url };
    if (kind === "fixed") {
      stats.fixed++;
      upd.location = { set: out };
      upd.verified = { set: true };
      upd.international = { set: false };
      upd.junk = { set: false };
      const didChange = JSON.stringify(before) !== JSON.stringify(out);
      if (didChange) stats.changed++; else stats.confirmed++;
      if (didChange && fixes.length < 500) fixes.push({ before, after: out, how });
    } else if (kind === "international") {
      stats.international++;
      upd.verified = { set: false };
      upd.international = { set: true };
      upd.junk = { set: false };
      if (intl.length < 300) intl.push({ before, value: out[0] || null, how });
    } else {
      stats.junk++;
      upd.verified = { set: false };
      upd.international = { set: false };
      upd.junk = { set: true };
      if (junk.length < 300) junk.push({ before, how });
    }

    pending.push(upd);
    bar.tick();
    if (APPLY && pending.length >= 500) { await solr.update(pending); pending = []; }
  }
  bar.done(APPLY ? "analysed and written" : "analysed");
  if (APPLY && pending.length) await solr.update(pending);
  if (APPLY) await solr.commit();
  const secs = (Date.now() - tScan) / 1000;

  console.log("");
  console.log("REWRITTEN  (" + fmt(stats.changed) + " of " + fmt(stats.fixed) + " verified)   before -> after");
  line();
  for (const f of fixes.slice(0, 30)) {
    console.log("  " + JSON.stringify(f.before) + "  ->  " + JSON.stringify(f.after) + "   [" + f.how + "]");
  }

  console.log("");
  console.log("INTERNATIONAL  (" + fmt(stats.international) + ")   flagged, original kept");
  line();
  for (const f of intl.slice(0, 15)) console.log("  " + JSON.stringify(f.before) + "   [" + f.how + "]");

  console.log("");
  console.log("JUNK  (" + fmt(stats.junk) + ")   not a place - candidates for purge-junk");
  line();
  for (const f of junk.slice(0, 15)) console.log("  " + JSON.stringify(f.before) + "   [" + f.how + "]");

  console.log("");
  console.log("SPEED");
  line();
  console.log("  analysed     : " + fmt(stats.scanned) + " docs");
  console.log("  elapsed      : " + secs.toFixed(1) + " s");
  console.log("  throughput   : " + fmt(Math.round(stats.scanned / Math.max(secs, 0.001))) + " docs/sec");
  console.log("  total run    : " + ((Date.now() - t0) / 1000).toFixed(1) + " s");

  console.log("");
  console.log("RESULT");
  line();
  console.log("  skipped (already verified) : " + fmt(okBefore));
  console.log("  analysed                   : " + fmt(stats.scanned));
  console.log("  verified now               : " + fmt(stats.fixed) + "  " + pct(stats.fixed, stats.scanned));
  console.log("    rewritten                : " + fmt(stats.changed));
  console.log("    already correct          : " + fmt(stats.confirmed));
  console.log("  international              : " + fmt(stats.international) + "  " + pct(stats.international, stats.scanned));
  console.log("  junk                       : " + fmt(stats.junk) + "  " + pct(stats.junk, stats.scanned));
  console.log(APPLY ? "" : "");
  console.log(APPLY ? "WRITTEN to Solr." : "DRY RUN - nothing written. Add --apply to write.");

  // cumulative catalogue of distinct rewrites, so the audit trail survives
  // runs where nothing new needed fixing
  if (APPLY && fixes.length) {
    const cf = path.join(HERE, "rewrite_catalog.json");
    const prev = fs.existsSync(cf) ? JSON.parse(fs.readFileSync(cf, "utf8")) : [];
    const seen = new Set(prev.map((x) => JSON.stringify(x.before) + JSON.stringify(x.after)));
    for (const f of fixes) {
      const k = JSON.stringify(f.before) + JSON.stringify(f.after);
      if (seen.has(k)) continue;
      seen.add(k);
      prev.push({ before: f.before, after: f.after, how: f.how, seen: new Date().toISOString().slice(0, 10) });
    }
    fs.writeFileSync(cf, JSON.stringify(prev, null, 2));
    console.log("rewrite catalogue: " + prev.length + " distinct patterns");
  }

  fs.writeFileSync(path.join(HERE, "last_run.json"), JSON.stringify({
    when: new Date().toISOString(), applied: APPLY, total, skipped: okBefore,
    localities: index.localities, counties: index.counties, stats,
    seconds: secs, throughput: Math.round(stats.scanned / Math.max(secs, 0.001)),
    fixes, intl, junk,
  }, null, 2));
  console.log("run detail saved to last_run.json");
}
async function purgeJunk(opts) {
  await requireSolr();
  const FORCE = opts && opts.apply === true;
  const PREVIEW_ONLY = opts && opts.preview === true;
  line("=");
  console.log("PURGE JUNK");
  line("=");

  const defined = new Set((await solr.fields()).map((f) => f.name));
  if (!defined.has("junk")) {
    console.log("The junk field does not exist yet. Run:  node doctor.js normalize --apply");
    return;
  }

  const n = await solr.count("junk:true");
  const total = await solr.count("*:*");
  console.log("");
  console.log("jobs flagged junk : " + fmt(n) + "  of " + fmt(total) + "  (" + pct(n, total) + ")");
  if (n === 0) { console.log("nothing to delete."); return; }

  console.log("");
  console.log("SAMPLE OF WHAT WOULD BE DELETED");
  line();
  for (const d of await solr.sample("junk:true", "url,title,company,location", 15)) {
    const t = String(d.title || "(no title)").slice(0, 44);
    console.log("  " + t.padEnd(46) + JSON.stringify(d.location || []));
  }

  if (PREVIEW_ONLY || (!FORCE && !has("--yes"))) {
    console.log("");
    console.log("preview only - nothing deleted. " + fmt(n) + " documents would go.");
    console.log("to confirm: node doctor.js purge-junk --yes");
    return;
  }

  console.log("");
  console.log("--yes supplied - deleting " + fmt(n) + " documents...");
  const t = Date.now();
  await solr.deleteByQuery("junk:true");
  const after = await solr.count("*:*");
  console.log("deleted in " + ((Date.now() - t) / 1000).toFixed(1) + "s");
  console.log("documents: " + fmt(total) + " -> " + fmt(after) + "   (removed " + fmt(total - after) + ")");
}

async function report() {
  await requireSolr();
  console.log("gathering live data from Solr...");
  const data = await gather();
  printReport(data);
  const out = path.join(HERE, "report.html");
  fs.writeFileSync(out, renderHtml(data));
  console.log("HTML report written to " + out);
}

(async () => {
  try {
    if (cmd === "health") await health();
    else if (cmd === "normalize") await normalize();
    else if (cmd === "purge-junk") await purgeJunk();
    else if (cmd === "report") await report();
    else if (cmd === "run") {
      await requireSolr();
      await runFlow({ solr, health, normalize, purgeJunk, report, fmt });
    }
    else {
      console.log("peviitor doctor - Solr health and data quality");
      console.log("");
      console.log("  node doctor.js health                 index overview, coverage, integrity");
      console.log("  node doctor.js normalize              analyse locations (dry run)");
      console.log("  node doctor.js normalize --apply      write the corrections");
      console.log("  node doctor.js normalize --limit 500  cap how many docs are analysed");
      console.log("  node doctor.js purge-junk             preview junk deletions");
      console.log("  node doctor.js purge-junk --yes       actually delete them");
      console.log("  node doctor.js report                 print report + write report.html");
      console.log("  node doctor.js run                    guided workflow, asks before writing");
    }
  } catch (e) {
    console.error("");
    console.error("FAILED: " + e.message);
    process.exit(1);
  }
})();
