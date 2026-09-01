#!/usr/bin/env node
"use strict";
// Regression harness for lib/locations.js. Pure offline check against
// tests/cases.json - no Solr needed. Exits non-zero if anything fails.
const fs = require("fs");
const path = require("path");
const { loadIndex, classify } = require("../lib/locations.js");

const HERE = __dirname;
const ROOT = path.join(HERE, "..");
const cases = JSON.parse(fs.readFileSync(path.join(HERE, "cases.json"), "utf8"));
const index = loadIndex(ROOT);

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const line = () => console.log("-".repeat(100));

let pass = 0, fail = 0;
const failures = [];

console.log("=".repeat(100));
console.log("LOCATION MATCHER REGRESSION TESTS   (" + cases.length + " cases, index loaded in " + index.ms + "ms)");
console.log("=".repeat(100));
line();
console.log(pad("", 4) + pad("INPUT", 46) + pad("GOT", 28) + "NOTE");
line();

for (const c of cases) {
  const r = classify(c.input, index);
  const reasons = [];

  if (c.expectKind !== undefined && r.kind !== c.expectKind) {
    reasons.push("expected kind=" + c.expectKind + " got " + r.kind);
  }
  if (c.expectValue !== undefined && r.value !== c.expectValue) {
    reasons.push("expected value=" + JSON.stringify(c.expectValue) + " got " + JSON.stringify(r.value));
  }
  if (c.notValue !== undefined && r.value === c.notValue) {
    reasons.push("value must NOT be " + JSON.stringify(c.notValue));
  }
  if (c.notKind !== undefined && r.kind === c.notKind) {
    reasons.push("kind must NOT be " + c.notKind);
  }

  const ok = reasons.length === 0;
  if (ok) pass++; else { fail++; failures.push({ c, r, reasons }); }

  const got = r.kind + (r.value ? (":" + r.value) : "");
  console.log((ok ? "PASS" : "FAIL").padEnd(4) + pad(c.input, 46) + pad(got, 28) + (c.note || ""));
}

line();
if (failures.length) {
  console.log("");
  console.log("FAILURE DETAIL");
  line();
  for (const { c, r, reasons } of failures) {
    console.log("  input : " + JSON.stringify(c.input));
    console.log("  got   : kind=" + r.kind + " value=" + JSON.stringify(r.value) + " how=" + r.how);
    for (const reason of reasons) console.log("  FAIL  : " + reason);
    console.log("");
  }
}

console.log("=".repeat(100));
console.log("RESULT: " + pass + " passed, " + fail + " failed, " + cases.length + " total");
console.log("=".repeat(100));

process.exit(fail ? 1 : 0);
