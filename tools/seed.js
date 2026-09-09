"use strict";
/**
 * Copy the latest run's summary into seed/latest.json so a container that
 * has never run the analysis opens with real numbers and an honest date.
 * Rows are not seeded: drill-down waits for the first run.
 *
 *   node tools/seed.js
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const src = path.join(ROOT, "runs", "latest.json");
const dst = path.join(ROOT, "seed", "latest.json");
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
const s = JSON.parse(fs.readFileSync(dst, "utf8"));
console.log(`seed/latest.json  ${Math.round(fs.statSync(dst).size / 1024)} KB, din ${s.runAt}, ${s.totals.jobs} anunțuri`);
