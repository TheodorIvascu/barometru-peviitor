"use strict";
/**
 * Load .env from the repo root into process.env. Existing variables win, so a
 * value set on the command line or by the host overrides the file.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function load(file) {
  const p = file || path.join(ROOT, ".env");
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); } catch { return {}; }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return out;
}

module.exports = { load, ROOT };
