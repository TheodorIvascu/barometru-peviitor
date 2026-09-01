"use strict";
const fmt = (n) => Number(n).toLocaleString("en-US");
const pct = (n, t) => (t ? ((n / t) * 100).toFixed(1) + "%" : "0.0%");
const rule = (c) => (c || "-").repeat(74);

function bar(frac, width) {
  const w = width || 30;
  const f = Math.round(Math.min(Math.max(frac, 0), 1) * w);
  return "#".repeat(f) + "-".repeat(w - f);
}

function printReport(d) {
  const c = d.counts;
  console.log(rule("="));
  console.log("SOLR DATA QUALITY REPORT");
  console.log(d.solrUrl + "   uniqueKey=" + d.uniqueKey + "   fields=" + d.fieldCount);
  console.log("generated " + d.generatedAt.replace("T", " ").slice(0, 19) + " UTC   (gathered in " + (d.gatherMs / 1000).toFixed(1) + "s)");
  console.log(rule("="));

  console.log("");
  console.log("DOCUMENTS " + fmt(c.total));
  console.log(rule());
  const rows = [
    ["verified (clean location)", c.verified, "OK"],
    ["international (foreign)", c.international, "FLAG"],
    ["junk (not a place)", c.junk, "JUNK"],
  ];
  for (const [label, n, tag] of rows) {
    console.log("  " + tag.padEnd(5) + label.padEnd(28) + fmt(n).padStart(8) + "  " + pct(n, c.total).padStart(6) + "  " + bar(n / c.total));
  }

  if (d.run) {
    const r = d.run;
    console.log("");
    console.log("LAST NORMALIZE RUN   " + r.when.replace("T", " ").slice(0, 19) + " UTC   " + (r.applied ? "[applied]" : "[dry run]"));
    console.log(rule());
    console.log("  reference data      : " + fmt(r.localities) + " official localities + " + r.counties + " counties (SIRUTA)");
    console.log("  skipped (verified)  : " + fmt(r.skipped));
    console.log("  analysed            : " + fmt(r.stats.scanned));
    console.log("    rewritten         : " + fmt(r.stats.changed));
    console.log("    already correct   : " + fmt(r.stats.confirmed));
    console.log("    international     : " + fmt(r.stats.international));
    console.log("    junk              : " + fmt(r.stats.junk));
    console.log("  elapsed             : " + r.seconds.toFixed(1) + "s at " + fmt(r.throughput) + " docs/sec");
  }

  console.log("");
  console.log("REWRITES   before -> after   (" + d.rewrites.length + " distinct patterns)");
  console.log(rule());
  for (const f of d.rewrites.slice(0, 20)) {
    console.log("  " + JSON.stringify(f.before).padEnd(34) + " -> " + JSON.stringify(f.after).padEnd(20) + " [" + f.how + "]");
  }

  console.log("");
  console.log("JUNK VALUES   " + fmt(c.junk) + " docs across " + d.junk.length + " distinct values");
  console.log(rule());
  for (const j of d.junk.slice(0, 12)) console.log("  " + fmt(j.count).padStart(6) + "  " + j.value);

  console.log("");
  console.log("INTERNATIONAL   " + fmt(c.international) + " docs across " + d.intl.length + " distinct values");
  console.log(rule());
  for (const j of d.intl.slice(0, 12)) console.log("  " + fmt(j.count).padStart(6) + "  " + j.value);

  console.log("");
  console.log("TOP VERIFIED LOCATIONS   (" + fmt(d.verifiedDistinct) + " distinct)");
  console.log(rule());
  for (const j of d.verifiedTop.slice(0, 12)) console.log("  " + fmt(j.count).padStart(6) + "  " + j.value);

  console.log("");
  console.log("FIELD COVERAGE");
  console.log(rule());
  for (const f of d.coverage) {
    const flag = f.n === f.total ? "OK  " : f.n === 0 ? "NONE" : "PART";
    console.log("  " + flag + " " + f.field.padEnd(10) + fmt(f.n).padStart(8) + "  " + pct(f.n, f.total).padStart(6) + "  " + bar(f.n / f.total, 24));
  }
  console.log("");
}
module.exports = { printReport };
