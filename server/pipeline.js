"use strict";
/**
 * server/pipeline.js - the whole analysis, and the schedule that runs it.
 *
 * The analysis is a scheduled job, not a chore: once when the process starts,
 * then an hourly check that does nothing unless the cache is more than a day
 * old. The button in the sidebar forces it early; nothing depends on anyone
 * pressing it. See startSchedule() at the bottom.
 *
 * Steps, in the order they must run:
 *   1. classify    (here)              - derive location_s / loc_kind
 *   2. materialize (server/jobs.js)    - evaluate every deterministic rule
 *   3. cor         (here)              - match titles against the COR registry
 *   4. sources     (lib/sources.js)    - group defects by scraper, diagnose
 *   5. summary     (lib/summary.js)    - the bulletin, written once a day
 *
 * It closes by writing lib/snapshot.js: the counts without the rows, small
 * enough to survive a restart, so a cold container never opens on a screen of
 * dashes while it recomputes.
 */
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");

let current = null;   // { step, running, startedAt, exitCode, lines[] }

function begin(step) {
  current = { step, running: true, startedAt: Date.now(), exitCode: null, lines: [] };
  return current;
}
function push(job, line) {
  if (!job) return;
  job.lines.push(line);
  if (job.lines.length > 400) job.lines.splice(0, job.lines.length - 400);
}

/** run a node script, streaming its stdout into the job log */
function runScript(job, script, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT });
    const feed = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) if (line.trim()) push(job, line);
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (e) => { push(job, "EROARE: " + e.message); resolve(1); });
    child.on("close", (code) => resolve(code));
  });
}

/** POST /api/classify { confirm: true } - writes the derived location fields */
async function postClassify({ body }) {
  if (!body || body.confirm !== true) {
    return { status: 400, body: { error: "trimite { confirm: true } ca sa pornesti clasificarea" } };
  }
  if (current && current.running) {
    return { status: 200, body: { started: false, alreadyRunning: true, step: current.step } };
  }
  const job = begin("classify");
  push(job, "clasific locatiile fata de registrul SIRUTA...");
  runScript(job, "classify.js").then((code) => {
    job.exitCode = code;
    job.running = false;
    push(job, code === 0 ? "clasificare terminata." : "clasificarea a esuat (cod " + code + ")");
  });
  return { status: 202, body: { started: "classify" } };
}

/**
 * POST /api/pipeline { confirm: true }
 * classify -> materialize -> judge, in order, as one job.
 */
async function postPipeline({ body }) {
  if (!body || body.confirm !== true) {
    return { status: 400, body: { error: "trimite { confirm: true } ca sa pornesti analiza completa" } };
  }
  if (current && current.running) {
    // the analysis starts by itself when the caches are stale, so a person
    // pressing the button often arrives mid-run. That is not an error - hand
    // them the running job so the console follows it.
    return { status: 200, body: { started: false, alreadyRunning: true, step: current.step } };
  }
  const job = begin("pipeline");

  (async () => {
    try {
      // ---- 1. classify -----------------------------------------------------
      job.step = "classify";
      push(job, "[1/5] clasific locatiile fata de registrul SIRUTA...");
      const c = await runScript(job, "classify.js");
      if (c !== 0) throw new Error("clasificarea a esuat (cod " + c + ")");

      // ---- 2. materialize --------------------------------------------------
      job.step = "materialize";
      push(job, "[2/5] evaluez toate regulile deterministe...");
      const rules = require(path.join(ROOT, "lib", "rules.js"));
      const m = await rules.materialize({
        onProgress: (n) => push(job, "    " + n.toLocaleString("ro-RO") + " documente"),
      });
      push(job, "    " + m.scanned.toLocaleString("ro-RO") + " documente in " + m.seconds + "s");
      for (const [k, v] of Object.entries(m.counts || {})) {
        push(job, "    " + String(v).padStart(7) + "  " + k);
      }

      // ---- 4. COR ----------------------------------------------------------
      job.step = "cor";
      push(job, "[3/5] potrivesc titlurile cu ocupatiile COR...");
      try {
        const c = await runCor((l) => push(job, "    " + l));
        push(job, "    " + c.matchedPct + "% potrivite, " + c.aiJobs + " prin model");
      } catch (e) { push(job, "    COR a esuat: " + e.message); }

      // ---- 5. sources ------------------------------------------------------
      job.step = "sources";
      push(job, "[4/5] grupez defectele pe sursa si cer diagnoza...");
      const src = require(path.join(ROOT, "lib", "sources.js"));
      const sb = await src.build({ minJobs: 100 });
      if (sb.ok) {
        push(job, "    " + sb.sources + " surse cu peste 100 de joburi");
        for (const r of sb.rows.slice(0, 3)) {
          push(job, "    " + r.host + ": " + r.affected + " / " + r.jobs + " afectate (" + r.affectedPct + "%)");
        }
        const dg = await src.diagnose({ max: 12 });
        push(job, dg.ok ? "    diagnoza AI: " + dg.diagnosed + " surse (" + dg.provider + ")"
                        : "    diagnoza AI: " + dg.error);
      } else {
        push(job, "    " + sb.error);
      }

      // ---- 5. bulletin -----------------------------------------------------
      job.step = "buletin";
      push(job, "[5/5] scriu buletinul zilei...");
      try {
        const sm = require(path.join(ROOT, "lib", "summary.js"));
        const r = await sm.generate({ force: true });
        push(job, r.ok === false ? "    " + r.error : "    scris de " + (r.model || "model"));
      } catch (e) { push(job, "    buletinul a esuat: " + e.message); }

      // the small copy that survives a restart, so the next cold container
      // opens with these numbers instead of a screen of dashes
      try {
        const snap = require(path.join(ROOT, "lib", "snapshot.js")).save();
        push(job, snap.ok ? "instantaneu salvat (" + Math.round(snap.bytes / 1024) + " KB)"
                          : "instantaneu: " + snap.error);
      } catch (e) { push(job, "instantaneu: " + e.message); }

      job.exitCode = 0;
      push(job, "analiza completa gata.");
    } catch (e) {
      job.exitCode = 1;
      push(job, "EROARE: " + e.message);
    } finally {
      job.running = false;
    }
  })();

  return { status: 202, body: { started: "pipeline" } };
}

/** GET /api/pipeline/status */
async function getPipelineStatus() {
  if (!current) return { status: 200, body: { running: false, step: null, lines: [] } };
  return {
    status: 200,
    body: {
      running: current.running,
      step: current.step,
      seconds: Math.round((Date.now() - current.startedAt) / 1000),
      exitCode: current.exitCode,
      lines: current.lines,
    },
  };
}

/**
 * GET /api/parity?sample=15
 * "Are the jobs we audit the same jobs peviitor.ro serves?" Samples real rows
 * and matches each one against production BY URL - the uniqueKey - because a
 * title query only OR-matches words and returns lookalikes.
 */
async function getParity({ query }) {
  const parity = require(path.join(ROOT, "lib", "parity.js"));
  const sample = Math.min(Math.max(parseInt(query && query.sample, 10) || 15, 1), 50);
  try {
    return { status: 200, body: await parity.check({ sample }) };
  } catch (e) {
    return { status: 502, body: { error: "nu pot verifica paritatea: " + e.message } };
  }
}

/** GET /api/parity/job?url=... - is this exact job still live in production? */
async function getParityJob({ query }) {
  const parity = require(path.join(ROOT, "lib", "parity.js"));
  const u = query && query.url;
  if (!u) return { status: 400, body: { error: "lipseste parametrul url" } };
  try {
    const r = await parity.existsInProd(u);
    return {
      status: 200,
      body: {
        url: u,
        found: !!r.found,
        prod: r.doc || null,
        siteUrl: parity.PUBLIC_API.replace("/v1/search/", "") ,
        search: "https://peviitor.ro/?q=" + encodeURIComponent((r.doc && r.doc.title) || ""),
      },
    };
  } catch (e) {
    return { status: 502, body: { error: e.message } };
  }
}

/**
 * POST /api/cor { confirm: true }
 * Recompute COR occupation matching over every distinct title and cache the
 * result, so the Ocupații tab is instant instead of a 20-second wait.
 */
async function postCor({ body }) {
  if (!body || body.confirm !== true) {
    return { status: 400, body: { error: "trimite { confirm: true } ca sa pornesti potrivirea COR" } };
  }
  if (current && current.running) {
    return { status: 200, body: { started: false, alreadyRunning: true, step: current.step } };
  }

  const job = begin("cor");
  push(job, "potrivesc titlurile cu cele 4.422 de ocupatii COR...");
  (async () => {
    try {
      await runCor((l) => push(job, l));
      job.exitCode = 0;
    } catch (e) {
      push(job, "EROARE: " + e.message);
      job.exitCode = 1;
    } finally { job.running = false; }
  })();

  return { status: 202, body: { started: "cor" } };
}

/**
 * The COR matching itself, with no job bookkeeping.
 *
 * It used to live inside postCor, which calls begin() — and begin() REPLACES
 * the module's `current` job. Calling it from the pipeline therefore destroyed
 * the pipeline's own status halfway through, which is why the COR step looked
 * like it never finished and the Ocupații tab stayed empty.
 */
async function runCor(log = () => {}) {
  {
    {
      const cor = require(path.join(ROOT, "lib", "cor.js"));
      const { Solr } = require(path.join(ROOT, "lib", "solr.js"));
      const solr = new Solr({ core: "job" });
      const index = cor.loadCor();

      // keep a little context per title: "Mecanic" cannot be placed from the
      // word alone, but "Mecanic" at an auto dealer with tags [auto, service]
      // usually can. The AI step needs this to do better than refusing.
      const titles = new Map();                 // title -> { count, companies:Set, tags:Set }
      let scanned = 0;
      for await (const d of solr.scan("*:*", "url,title,company,tags")) {
        scanned++;
        const t = String(d.title || "").trim();
        if (!t) continue;
        let e = titles.get(t);
        if (!e) { e = { count: 0, companies: new Set(), tags: new Set() }; titles.set(t, e); }
        e.count++;
        if (d.company && e.companies.size < 3) e.companies.add(String(d.company));
        for (const g of (Array.isArray(d.tags) ? d.tags : [])) if (e.tags.size < 8) e.tags.add(String(g));
        if (scanned % 20000 === 0) log("  " + scanned.toLocaleString("ro-RO") + " documente");
      }
      log("  " + titles.size.toLocaleString("ro-RO") + " titluri distincte");

      // verdicts the model already gave for titles COR has no wording for
      // ("Consultant vanzari" -> "agent de vanzari"); they count as matches,
      // and are labelled so the tier breakdown stays honest
      let aiVerdicts = new Map();
      try { aiVerdicts = require(path.join(ROOT, "lib", "cor_ai.js")).verdicts(); } catch { /* none yet */ }

      let matchedJobs = 0, matchedTitles = 0, ambiguousJobs = 0, aiJobs = 0;
      const tiers = {};
      const unmatched = [];
      const ambiguous = [];
      const byCode = new Map();

      // matching 34.000 titles against 4.422 occupations is CPU-bound; without
      // yielding, Node stops answering every other request for the duration and
      // the whole app looks frozen
      let seen = 0;
      for (const [title, info] of titles) {
        if (++seen % 500 === 0) {
          await new Promise((r) => setImmediate(r));
          if (seen % 5000 === 0) log("  potrivit " + seen.toLocaleString("ro-RO") + " titluri");
        }
        const count = info.count;
        const m = cor.matchTitle(title, index);
        if (m && m.code) {
          matchedJobs += count; matchedTitles++;
          const tier = cor.tierOf ? cor.tierOf(m.how) : m.how;
          tiers[tier] = (tiers[tier] || 0) + count;
          const cur = byCode.get(m.code) || { code: m.code, name: m.name, count: 0 };
          cur.count += count; byCode.set(m.code, cur);
        } else if (aiVerdicts.has(title)) {
          const v = aiVerdicts.get(title);
          matchedJobs += count; matchedTitles++; aiJobs += count;
          tiers.ai = (tiers.ai || 0) + count;
          const cur = byCode.get(v.code) || { code: v.code, name: v.name, count: 0 };
          cur.count += count; byCode.set(v.code, cur);
        } else if (m && m.ambiguous) {
          ambiguousJobs += count;
          if (ambiguous.length < 400) {
            ambiguous.push({
              title, count, candidates: m.candidates,
              companies: [...info.companies], tags: [...info.tags],
            });
          }
        } else if (unmatched.length < 400) {
          unmatched.push({ title, count });
        }
      }

      const out = {
        at: new Date().toISOString(),
        jobs: scanned,
        distinctTitles: titles.size,
        matchedJobs,
        matchedTitles,
        matchedPct: scanned ? +((matchedJobs / scanned) * 100).toFixed(2) : 0,
        ambiguousJobs,
        aiJobs,
        tiers,
        topOccupations: [...byCode.values()].sort((a, b) => b.count - a.count).slice(0, 40),
        unmatchedTitles: unmatched.sort((a, b) => b.count - a.count).slice(0, 60),
        ambiguousTitles: ambiguous.sort((a, b) => b.count - a.count).slice(0, 60),
      };
      require("fs").writeFileSync(path.join(ROOT, "cache", "cor.json"), JSON.stringify(out), "utf8");

      log("potrivite " + matchedJobs.toLocaleString("ro-RO") + " / " + scanned.toLocaleString("ro-RO")
        + " joburi = " + out.matchedPct + "%");
      log("din care plasate de model: " + aiJobs.toLocaleString("ro-RO"));
      log("ambigue (titlu prea generic): " + ambiguousJobs.toLocaleString("ro-RO"));
      return out;
    }
  }
}

/** GET /api/cor - the cached COR result */
async function getCor() {
  try {
    const j = JSON.parse(require("fs").readFileSync(path.join(ROOT, "cache", "cor.json"), "utf8"));
    return { status: 200, body: j };
  } catch {
    // container restarted before the daily run finished; the snapshot still has it
    const snap = require(path.join(ROOT, "lib", "snapshot.js")).read();
    if (snap && snap.cor) return { status: 200, body: { ...snap.cor, stale: true } };
    return { status: 409, body: { error: "nemasurat", hint: "Analiza zilnica nu a rulat inca." } };
  }
}

/** GET /api/summary  — the AI bulletin for the dashboard (cached) */
async function getSummary({ query }) {
  const summary = require(path.join(ROOT, "lib", "summary.js"));
  try {
    const r = await summary.generate({ force: !!(query && query.force) });
    return { status: 200, body: r };
  } catch (e) {
    return { status: 502, body: { ok: false, error: e.message } };
  }
}

/** POST /api/cor/ai { confirm:true } — model places the ambiguous titles */
async function postCorAi({ body }) {
  if (!body || body.confirm !== true) {
    return { status: 400, body: { error: "trimite { confirm: true }" } };
  }
  try {
    const fs2 = require("fs");
    const cor = JSON.parse(fs2.readFileSync(path.join(ROOT, "cache", "cor.json"), "utf8"));
    const ai = require(path.join(ROOT, "lib", "cor_ai.js"));
    const r = await ai.resolve(cor.ambiguousTitles || [], { max: 60 });
    return { status: 200, body: r };
  } catch (e) {
    return { status: 502, body: { ok: false, error: e.message } };
  }
}

/** GET /api/ai — which model does what, and what we refuse to send to a model */
async function getAiRouting() {
  const t = require(path.join(ROOT, "lib", "ai_tasks.js"));
  return { status: 200, body: t.routing() };
}

/** POST /api/ai/locations { confirm:true } — recover real places from junk */
async function postAiLocations({ body }) {
  if (!body || body.confirm !== true) return { status: 400, body: { error: "trimite { confirm: true }" } };
  const t = require(path.join(ROOT, "lib", "ai_tasks.js"));
  try {
    return { status: 200, body: await t.recoverJunkLocations({ max: 60 }) };
  } catch (e) {
    return { status: 502, body: { ok: false, error: e.message } };
  }
}

/** GET /api/ai/locations — what the last recovery run accepted */
async function getAiLocations() {
  const t = require(path.join(ROOT, "lib", "ai_tasks.js"));
  const c = t.readCache();
  const all = Object.values(c.entries || {});
  return {
    status: 200,
    body: {
      recovered: all.filter((e) => e.accepted).length,
      refused: all.filter((e) => e.proposed && !e.accepted).length,
      nulls: all.filter((e) => !e.proposed).length,
      rows: all.filter((e) => e.accepted).sort((a, b) => b.count - a.count).slice(0, 60),
    },
  };
}

/**
 * Run the analysis automatically when it is missing or stale.
 *
 * Classifying locations and adjudicating the flagged titles are not decisions a
 * user should have to make - they are what the tool IS. The buttons stay for
 * forcing a re-run, but nobody should have to press one to see real numbers.
 */
async function autoRefresh({ reason = "pornire" } = {}) {
  const fs2 = require("fs");
  const { Solr } = require(path.join(ROOT, "lib", "solr.js"));

  let total = 0;
  try { total = await new Solr({ core: "job" }).count("*:*"); }
  catch { return { skipped: "solr indisponibil" }; }
  if (!total) return { skipped: "index gol" };

  /**
   * A run is due when the cache was computed against a different index size, or
   * when it is simply old. The size check alone was not enough: an index that
   * happens to hold the same number of jobs today as yesterday is not the same
   * index, and the dashboard would have quietly served week-old counts.
   */
  const stale = (file, key) => {
    try {
      const j = JSON.parse(fs2.readFileSync(path.join(ROOT, "cache", file), "utf8"));
      if ((j[key] || 0) !== total) return true;
      const at = Date.parse(j.at || 0);
      return !at || Date.now() - at > MAX_AGE_MS;
    } catch { return true; }               // never computed
  };

  const needLoc = stale("locations.json", "count");
  const needRules = stale("rules.json", "scanned");
  const needCor = stale("cor.json", "jobs");
  if (!needLoc && !needRules && !needCor) return { skipped: "deja la zi", total };

  if (current && current.running) return { skipped: "ruleaza deja" };
  console.log("[auto] " + reason + ": recalculez analiza pentru " + total + " joburi");
  await postPipeline({ body: { confirm: true } });
  return { started: true, total, needLoc, needRules, needCor };
}

/**
 * The daily cadence.
 *
 * Nobody should have to press a button to see today's numbers, and nobody
 * should be able to make this thing hammer production by pressing it a lot. So
 * the analysis is a scheduled job: once when the process comes up, then a check
 * every hour that does nothing at all unless the cache is older than a day.
 *
 * The hourly tick is cheap - one count query against Solr - and it exists
 * because a host that puts the container to sleep will never reach a timer set
 * for twenty-four hours from now. Waking up and finding the work already done
 * is the normal case.
 */
const MAX_AGE_MS = 22 * 60 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000;

function startSchedule() {
  const tick = (reason) =>
    autoRefresh({ reason })
      .then((r) => { if (!r.skipped) console.log("[zilnic] " + JSON.stringify(r)); })
      .catch((e) => console.log("[zilnic] esuat: " + e.message));

  setTimeout(() => tick("pornire server"), 1500);
  const t = setInterval(() => tick("verificare orara"), TICK_MS);
  if (t.unref) t.unref();
  return { everyMs: TICK_MS, maxAgeMs: MAX_AGE_MS };
}

/** GET /api/sources — defects grouped by the scraper that produced them */
async function getSources({ query }) {
  const src = require(path.join(ROOT, "lib", "sources.js"));
  const cached = src.read();
  if (cached && !(query && query.refresh)) return { status: 200, body: cached };
  try {
    const r = await src.build({ minJobs: 100 });
    return r.ok ? { status: 200, body: r } : { status: 409, body: r };
  } catch (e) {
    const snap = require(path.join(ROOT, "lib", "snapshot.js")).read();
    if (snap && snap.sources) return { status: 200, body: { ...snap.sources, stale: true } };
    return { status: 502, body: { ok: false, error: e.message } };
  }
}

/** POST /api/sources/diagnose { confirm:true } — model names the likely cause */
async function postSourcesDiagnose({ body }) {
  if (!body || body.confirm !== true) return { status: 400, body: { error: "trimite { confirm: true }" } };
  const src = require(path.join(ROOT, "lib", "sources.js"));
  try {
    return { status: 200, body: await src.diagnose({ max: 12 }) };
  } catch (e) {
    return { status: 502, body: { ok: false, error: e.message } };
  }
}

/**
 * POST /api/peviitor/open { title, cif }
 * Opens peviitor.ro in a REAL browser on this machine, finds the job in their
 * result list, highlights it and scrolls to it. Playwright drives a browser it
 * launches itself, so this cannot run in the user's tab - it has to be here.
 */
async function postPeviitorOpen({ body }) {
  const b = body || {};
  if (!b.title && !b.cif) return { status: 400, body: { error: "trimite { title } sau { cif }" } };
  try {
    const pv = require(path.join(ROOT, "lib", "peviitor_open.js"));
    const r = await pv.openAndHighlight({ title: b.title, cif: b.cif, company: b.company, headless: false });
    return { status: r.ok ? 200 : 502, body: r };
  } catch (e) {
    return { status: 502, body: { ok: false, error: e.message } };
  }
}

module.exports = { startSchedule, postClassify, postPipeline, getPipelineStatus, getParity, getParityJob, postCor, getCor, getSummary, postCorAi, getAiRouting, postAiLocations, getAiLocations, autoRefresh, getSources, postSourcesDiagnose, postPeviitorOpen };
