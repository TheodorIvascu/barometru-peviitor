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

  // the location donut is answered straight from Solr, so it needs nothing here
  const snap = {
    at: rules.at || Date.now(),
    scanned: rules.scanned || 0,
    counts: rules.counts,
    cor: cor || null,
    sources: sources || null,
    summary: summary || null,
    report: report || null,
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

module.exports = { save, read, promote, LIVE, SEED };
