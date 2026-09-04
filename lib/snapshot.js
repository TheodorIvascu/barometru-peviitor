"use strict";
/**
 * lib/snapshot.js - the small, durable copy of what the dashboard shows.
 *
 * The full analysis lives in cache/ and weighs about 300 MB, because it keeps
 * the id of every job behind every rule so a number can be clicked open. That
 * directory is derived data: it is not in git, not in the image, and on a host
 * that restarts the container it is simply gone. The first visitor after a
 * restart would then meet a dashboard of dashes for the minute it takes to
 * recompute - which is the one thing a status page must never do.
 *
 * So after every successful run we also write this: the counts without the
 * rows, the COR summary, the per-source table and the bulletin. Sixty kilobytes
 * instead of three hundred megabytes. A copy of it is committed under seed/ and
 * ships inside the image, so a container that has never run the analysis still
 * opens with real numbers and an honest date on them.
 *
 * It is a fallback, never the truth: the moment cache/rules.json exists again,
 * everything reads from that instead.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LIVE = path.join(ROOT, "cache", "snapshot.json");
const SEED = path.join(ROOT, "seed", "snapshot.json");

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/**
 * Collapse the current cache into the small form.
 * Called at the end of the pipeline; safe to call when parts are missing.
 */
function save() {
  const rules = readJson(path.join(ROOT, "cache", "rules.json"));
  if (!rules || !rules.counts) return { ok: false, error: "nu exista cache/rules.json" };

  const cor = readJson(path.join(ROOT, "cache", "cor.json"));
  const sources = readJson(path.join(ROOT, "cache", "sources.json"));
  const summary = readJson(path.join(ROOT, "cache", "summary.json"));
  const report = readJson(path.join(ROOT, "cache", "report.json"));

  // the county map needs cache/locations.json, which is the biggest thing the
  // pipeline writes and the first thing missing after a restart; the tally is
  // 42 numbers, so it rides along and the map opens with yesterday's picture
  /**
   * The model's verdicts ride along too.
   *
   * These are the only entries in cache/ that cost money. They live there
   * because that is where derived data goes, and cache/ does not survive a
   * restart - so every redeploy threw away a few hundred adjudicated titles and
   * bought them again, which on a daily budget of a hundred calls means the
   * COR pass runs out halfway through. 140 KB carried here buys them once.
   */
  const corAi = readJson(path.join(ROOT, "cache", "cor_ai.json"));
  const locAi = readJson(path.join(ROOT, "cache", "loc_ai.json"));

  let counties = null;
  try { counties = require(path.join(ROOT, "server", "jobs.js")).countyItems(); } catch { /* none yet */ }

  // the location donut is answered straight from Solr, so it needs nothing here
  const snap = {
    at: rules.at || Date.now(),
    scanned: rules.scanned || 0,
    counts: rules.counts,
    cor: cor || null,
    sources: sources || null,
    summary: summary || null,
    report: report || null,
    counties,
    corAi: corAi || null,
    locAi: locAi || null,
  };
  fs.mkdirSync(path.dirname(LIVE), { recursive: true });
  fs.writeFileSync(LIVE, JSON.stringify(snap));
  return { ok: true, bytes: fs.statSync(LIVE).size, at: snap.at };
}

/** Freshest first: this container's own run, then the one baked into the image. */
function read() {
  const live = readJson(LIVE);
  if (live) return { ...live, from: "cache" };
  const seed = readJson(SEED);
  if (seed) return { ...seed, from: "seed" };
  return null;
}

/** Promote the current snapshot to the committed seed. Run by tools/seed.js. */
function promote() {
  const live = readJson(LIVE);
  if (!live) return { ok: false, error: "nu exista cache/snapshot.json" };
  fs.mkdirSync(path.dirname(SEED), { recursive: true });
  fs.writeFileSync(SEED, JSON.stringify(live));
  return { ok: true, bytes: fs.statSync(SEED).size, at: live.at };
}

/**
 * Put the paid-for verdicts back where the code that uses them looks.
 *
 * Called once at startup, before the first analysis. It only ever writes files
 * that are not there: a container that still has its own cache keeps it, and a
 * fresh one starts from what the last run learned instead of from nothing.
 */
function restore() {
  const snap = read();
  if (!snap) return { restored: [] };
  const back = [];
  for (const [key, file] of [["corAi", "cor_ai.json"], ["locAi", "loc_ai.json"]]) {
    if (!snap[key]) continue;
    const target = path.join(ROOT, "cache", file);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(snap[key]));
    back.push(file);
  }
  return { restored: back, from: snap.from };
}

module.exports = { save, read, promote, restore, LIVE, SEED };
