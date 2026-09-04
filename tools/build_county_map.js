"use strict";
/**
 * tools/build_county_map.js — locality name to county, in a file small enough
 * to live in git.
 *
 * siruta_localities.json is 4,2 MB of registry and only three of its fields
 * matter here. It is also in .dockerignore, so on a host that builds an image
 * the county map came out empty while every other location number was right —
 * which looked like a bug in the map and was a missing file.
 *
 *   node tools/build_county_map.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const strip = (v) => String(v || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[șş]/gi, "s").replace(/[țţ]/gi, "t").toLowerCase().trim();

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "siruta_localities.json"), "utf8"));
const out = {};
for (const loc of raw) {
  if (!loc || !loc.county) continue;
  for (const name of [loc.name, loc.name_ascii, loc.parent && loc.parent.name]) {
    const k = strip(name);
    if (k && !out[k]) out[k] = loc.county;
  }
}
const file = path.join(ROOT, "data", "locality_county.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out));
console.log("data/locality_county.json  " + Object.keys(out).length + " localitati, "
  + Math.round(fs.statSync(file).size / 1024) + " KB");
