"use strict";
/**
 * The three write actions, driven from the web UI.
 * Every one of them is gated: nothing runs without an explicit confirmation
 * in the request body. Wiping additionally requires a typed phrase.
 *
 * Each action runs as a child process and its progress is kept in memory so
 * the UI can poll /api/action/status while it works.
 */
const { spawn } = require("child_process");
const path = require("path");
const { Solr } = require(path.join(__dirname, "..", "lib", "solr.js"));

const ROOT = path.join(__dirname, "..");
const POPULATE = path.join(ROOT, "tools", "populate_from_prod.ps1");

let current = null; // { action, startedAt, finishedAt, running, exitCode, lines[] }

function state() {
  if (!current) return { running: false, action: null, lines: [] };
  return {
    running: current.running,
    action: current.action,
    startedAt: current.startedAt,
    finishedAt: current.finishedAt || null,
    exitCode: current.exitCode,
    seconds: ((current.finishedAt || Date.now()) - current.startedAt) / 1000,
    lines: current.lines.slice(-40),
  };
}

function begin(action) {
  current = { action, startedAt: Date.now(), finishedAt: null, running: true, exitCode: null, lines: [] };
  return current;
}

function push(job, chunk) {
  const text = String(chunk).replace(/\u0000/g, "");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t) job.lines.push(t.slice(0, 200));
  }
  if (job.lines.length > 400) job.lines = job.lines.slice(-400);
}

function runChild(job, cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, Object.assign({ cwd: ROOT }, opts || {}));
    child.stdout.on("data", (d) => push(job, d));
    child.stderr.on("data", (d) => push(job, d));
    child.on("close", (code) => {
      job.exitCode = code;
      job.running = false;
      job.finishedAt = Date.now();
      resolve(code);
    });
    child.on("error", (e) => {
      push(job, "FAILED TO START: " + e.message);
      job.exitCode = -1;
      job.running = false;
      job.finishedAt = Date.now();
      resolve(-1);
    });
  });
}

/** POST /api/action/normalize   body { confirm: true } */
async function postNormalizeAction({ body }) {
  if (!body || body.confirm !== true) {
    return { status: 400, body: { error: "refuz sa scriu: trimite { confirm: true }" } };
  }
  if (current && current.running) {
    return { status: 409, body: { error: "deja ruleaza: " + current.action } };
  }
  const job = begin("normalize");
  runChild(job, process.execPath, ["doctor.js", "normalize", "--apply"]);
  return { status: 202, body: { started: "normalize", message: "normalizarea locatiilor a pornit" } };
}

/** POST /api/action/repopulate   body { confirm: true } */
async function postRepopulateAction({ body }) {
  if (!body || body.confirm !== true) {
    return { status: 400, body: { error: "refuz: trimite { confirm: true }" } };
  }
  if (current && current.running) {
    return { status: 409, body: { error: "deja ruleaza: " + current.action } };
  }
  const job = begin("repopulate");
  push(job, "sterg si reincarc ambele core-uri din solr.peviitor.ro ...");
  runChild(job, "powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", POPULATE]);
  return { status: 202, body: { started: "repopulate", message: "repopularea a pornit (cateva minute)" } };
}

/**
 * POST /api/action/wipe   body { confirm: true, phrase: "STERGE", cores: ["job"] }
 * Deliberately harder than the others: it destroys data with no undo except a
 * repopulate from production.
 */
async function postWipeAction({ body }) {
  const b = body || {};
  if (b.confirm !== true) return { status: 400, body: { error: "refuz: trimite { confirm: true }" } };
  if (String(b.phrase || "").trim().toUpperCase() !== "STERGE") {
    return { status: 400, body: { error: 'refuz: scrie exact STERGE in campul phrase pentru a confirma' } };
  }
  if (current && current.running) return { status: 409, body: { error: "deja ruleaza: " + current.action } };

  const cores = Array.isArray(b.cores) && b.cores.length ? b.cores : ["job"];
  const allowed = cores.filter((c) => c === "job" || c === "company");
  if (!allowed.length) return { status: 400, body: { error: "core necunoscut" } };

  const job = begin("wipe");
  const before = {};
  try {
    for (const core of allowed) {
      const s = new Solr({ core });
      before[core] = await s.count("*:*");
      push(job, `${core}: ${before[core]} documente inainte`);
      await s.deleteByQuery("*:*");
      const after = await s.count("*:*");
      push(job, `${core}: ${after} documente dupa stergere`);
    }
    job.exitCode = 0;
  } catch (e) {
    push(job, "EROARE: " + e.message);
    job.exitCode = 1;
  }
  job.running = false;
  job.finishedAt = Date.now();
  return { status: 200, body: { done: "wipe", cores: allowed, before, lines: job.lines } };
}

async function getActionStatus() {
  return { status: 200, body: state() };
}

module.exports = { postNormalizeAction, postRepopulateAction, postWipeAction, getActionStatus };
