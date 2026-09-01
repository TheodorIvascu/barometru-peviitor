"use strict";
/**
 * lib/env.js - load .env into process.env.
 *
 * Required as early as possible by every entry point (server, CLI scripts), so
 * a child process spawned by the server sees the same configuration as the
 * server itself. Without this, `classify.js` fell back to the default Solr port
 * and hit a DIFFERENT Solr belonging to another stack, which answered 401.
 *
 * Existing environment variables always win, so a value set on the command line
 * overrides the file.
 */
const fs = require("fs");
const path = require("path");

function load(file) {
  const p = file || path.join(__dirname, "..", ".env");
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); } catch { return {}; }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return out;
}

module.exports = { load };
