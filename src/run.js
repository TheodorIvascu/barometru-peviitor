"use strict";
/**
 * One analysis run:
 *
 *   1. scan the company core            -> Map(cifKey -> company)
 *   2. scan the job core, enrich each   -> jobs[]
 *   3. mark what arrived since last run -> e.isNew, e.firstSeen
 *   4. probe a sample of links per host -> e.link
 *   5. run every check on every job     -> e.issues
 *   6. build the statistics             -> summary
 *   7. write runs/latest.json (summary) and runs/jobs.json (the rows)
 *
 * Also usable from the command line:  node src/run.js
 */
const fs = require("fs");
const path = require("path");
const { ROOT } = require("./env.js");
const { Solr } = require("./solr.js");
const { loadIndex } = require("./locations.js");
const { enrichJob, enrichCompany } = require("./enrich.js");
const { issuesOf } = require("./checks.js");
const { probeLinks, linksFromJobs } = require("./links.js");
const { buildStats } = require("./stats.js");
const rows = require("./rows.js");
const seen = require("./seen.js");

const RUNS = path.join(ROOT, "runs");
const JOB_FIELDS = "url,title,company,cif,location,tags,workmode,date,status,vdate,expirationdate,salary";
const COMPANY_FIELDS = "id,company,status,scraperFile,lastScraped";

let index = null;
const getIndex = () => index || (index = loadIndex(path.join(ROOT, "data")));

const yieldNow = () => new Promise((r) => setImmediate(r));

async function run(opts = {}) {
  const log = opts.log || (() => {});
  const t0 = Date.now();
  const now = Date.now();
  const idx = getIndex();
  log("start", { localities: idx.localities, indexMs: idx.ms });

  // 1. companies
  const companies = new Map();
  const companyCore = new Solr("company");
  let nCo = 0;
  for await (const d of companyCore.scan("*:*", COMPANY_FIELDS, { sort: "id asc" })) {
    const c = enrichCompany(d);
    if (c.key) companies.set(c.key, c);
    if (++nCo % 5000 === 0) log("companies", { scanned: nCo });
  }
  log("companies", { scanned: nCo, distinct: companies.size });

  // 2. jobs
  const jobs = [];
  const jobCore = new Solr("job");
  const ctx = { index: idx, companies, now };
  for await (const d of jobCore.scan("*:*", JOB_FIELDS)) {
    jobs.push(enrichJob(d, ctx));
    if (jobs.length % 1000 === 0) { log("jobs", { scanned: jobs.length }); await yieldNow(); }
  }
  log("jobs", { scanned: jobs.length });
  for (const e of jobs) { const co = e.cifKey && companies.get(e.cifKey); if (co) co.jobs++; }

  // 3. evidența intrărilor: ce a apărut de la ultima analiză
  const flow = seen.mark(jobs, now);
  log("intrari", flow);

  // 4. links, sampled. --no-links reuses the previous run's verdicts instead of probing again.
  let links = null;
  if (opts.links !== false) {
    links = await probeLinks(jobs, { onProgress: (done, of) => log("links", { done, of }) });
    log("links", { sampled: links.sampled, dead: links.dead, unreachable: links.unreachable, ms: links.ms });
  } else {
    const known = new Map();
    await rows.scan((p) => { if (p.link) known.set(p.url, { link: p.link, code: p.linkCode, reason: p.linkReason }); });
    if (known.size) {
      for (const e of jobs) { const l = known.get(e.url); if (l) { e.link = l.link; e.linkCode = l.code; e.linkReason = l.reason; } }
      const prev = loadLatest();
      links = linksFromJobs(jobs, prev && prev.summary.links && prev.summary.links.perHost);
      log("links", { reused: true, sampled: links.sampled, dead: links.dead });
    }
  }

  // 5. checks
  // Duplicates: same title, same company, SAME PLACE. The place matters — one
  // retailer posts "lucrător comercial" in 27 different towns and those are 27
  // real jobs, not 26 copies. Within a group the oldest url is the original.
  const dupSeen = new Map();
  for (const e of jobs.slice().sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.url.localeCompare(b.url))) {
    if (!e.ntitle) { e.dupIndex = 0; continue; }
    const place = e.loc.value || e.location.join(",").toLowerCase();
    const k = e.ntitle + "|" + e.cifKey + "|" + place;
    e.dupIndex = dupSeen.get(k) || 0;
    dupSeen.set(k, e.dupIndex + 1);
  }
  const checkCtx = { now };
  let i = 0;
  for (const e of jobs) {
    e.issues = issuesOf(e, checkCtx);
    if (++i % 2000 === 0) await yieldNow();
  }
  log("checks", { done: jobs.length });

  // 6. stats
  const summary = buildStats(jobs, companies, links, flow, {
    runAt: new Date(now).toISOString(),
    durationMs: Date.now() - t0,
    solr: process.env.SOLR_BASE,
  });
  log("stats", { trusted: summary.totals.trusted, affected: summary.totals.affected });

  // 7. persist, plus one small history entry per day so the front page can show a trend
  fs.mkdirSync(path.join(RUNS, "history"), { recursive: true });
  const day = summary.runAt.slice(0, 10);
  fs.writeFileSync(path.join(RUNS, "history", day + ".json"), JSON.stringify({
    runAt: summary.runAt, totals: summary.totals,
    incoming: summary.incoming ? { jobs: summary.incoming.jobs, affected: summary.incoming.affected, gone: summary.incoming.gone } : null,
    questions: summary.questions.map((q) => ({ id: q.id, affected: q.affected })),
    sources: summary.sources.map((s) => ({ host: s.host, jobs: s.jobs, affected: s.affected })),
  }), "utf8");
  summary.trend = trendFromHistory(day);
  summary.recentRuns = recentRuns(4);
  fs.writeFileSync(path.join(RUNS, "latest.json"), JSON.stringify(summary), "utf8");
  const written = await rows.write(jobs.map(compact));
  log("saved", { randuri: written.rows, mb: Math.round(written.bytes / 1048576), ms: Date.now() - t0 });

  // rândurile nu se mai întorc: sunt pe disc, iar apelantul nu trebuie să le
  // țină în memorie ca să le poată servi
  return { summary };
}

/**
 * Compare today with the run closest to 7 days ago (or the oldest we have).
 * Returns null on the first day: a trend needs two points.
 */
function trendFromHistory(today) {
  let files;
  try { files = fs.readdirSync(path.join(RUNS, "history")).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort(); } catch { return null; }
  const past = files.filter((d) => d < today);
  if (!past.length) return null;
  const target = new Date(Date.parse(today) - 7 * 86400000).toISOString().slice(0, 10);
  const pick = past.filter((d) => d <= target).pop() || past[0];
  try {
    const h = JSON.parse(fs.readFileSync(path.join(RUNS, "history", pick + ".json"), "utf8"));
    return { since: pick, days: Math.round((Date.parse(today) - Date.parse(pick)) / 86400000), totals: h.totals, questions: h.questions };
  } catch { return null; }
}

/** ultimele rulări salvate, cea mai nouă prima; pentru tooltipul din bara laterală */
function recentRuns(n) {
  let files;
  try { files = fs.readdirSync(path.join(RUNS, "history")).filter((f) => /^d{4}-d{2}-d{2}.json$/.test(f)).sort().reverse().slice(0, n); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const h = JSON.parse(fs.readFileSync(path.join(RUNS, "history", f), "utf8"));
      out.push({ runAt: h.runAt, jobs: h.totals.jobs, trusted: h.totals.trusted, affected: h.totals.affected,
        incoming: h.incoming || null });
    } catch { /* fișier stricat, îl sărim */ }
  }
  return out;
}

/** what the server needs per row to filter and to list; drops the company object */
function compact(e) {
  return {
    url: e.url, firstSeen: e.firstSeen, isNew: e.isNew, daysHere: e.daysHere, title: e.title, company: e.company, cif: e.cif, cifKey: e.cifKey, location: e.location, tags: e.tags,
    workmode: e.workmode, date: e.date, status: e.status, age: e.age, host: e.host, ntitle: e.ntitle,
    loc: e.loc, coStatus: e.co ? e.co.status : "", coChecked: e.co ? e.co.lastScraped : "",
    issues: e.issues, link: e.link, linkCode: e.linkCode, linkReason: e.linkReason,
  };
}

/** rezumatul ultimei rulări, sau null. Rândurile rămân pe disc. */
function loadLatest() {
  try { return { summary: JSON.parse(fs.readFileSync(path.join(RUNS, "latest.json"), "utf8")) }; }
  catch { return null; }
}

/** the committed seed: a summary only, so a fresh container shows real numbers before its first run */
function loadSeed() {
  try { return { summary: JSON.parse(fs.readFileSync(path.join(ROOT, "seed", "latest.json"), "utf8")), jobs: null }; }
  catch { return null; }
}

module.exports = { run, loadLatest, loadSeed, compact };

if (require.main === module) {
  const noLinks = process.argv.includes("--no-links");
  run({ links: !noLinks, log: (step, info) => console.log(step.padEnd(10), JSON.stringify(info)) })
    .then(({ summary }) => {
      console.log("\n" + summary.totals.trusted + " din " + summary.totals.jobs + " anunțuri sunt de încredere");
      for (const q of summary.questions) console.log("  " + String(q.affected).padStart(6) + "  " + q.label);
      for (const c of summary.checks.filter((c) => c.count).sort((a, b) => b.count - a.count).slice(0, 12)) {
        console.log("  " + String(c.count).padStart(6) + "  " + c.severity.padEnd(9) + c.label);
      }
    })
    .catch((e) => { console.error("EȘUAT:", e.stack || e.message); process.exit(1); });
}
