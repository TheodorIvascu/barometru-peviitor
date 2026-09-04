"use strict";
/**
 * lib/sources.js - defects grouped by where the data came from.
 *
 * This is the view that turns a report into something a person can act on.
 * "37.028 duplicate jobs" is a number nobody can do anything with. But
 * "jobviewtrack.com produced 14.239 of them, out of 15.208 jobs it supplied"
 * names one broken scraper, and fixing that one scraper removes thousands of
 * rows at once.
 *
 * `source` is empty on every document in production, so the origin is derived
 * from the job url's hostname - which is exactly what identifies the scraper.
 */
const path = require("path");
const fs = require("fs");
const { Solr } = require(path.join(__dirname, "solr.js"));

const CACHE = path.join(__dirname, "..", "cache", "sources.json");

function hostOf(u) {
  try { return new URL(String(u)).hostname.replace(/^www\./, ""); }
  catch { return "(url invalid)"; }
}

/**
 * @param {number} minJobs ignore long-tail domains; a source with 12 jobs and
 *                         3 defects is noise, not a broken scraper
 */
async function build({ minJobs = 100 } = {}) {
  const t0 = Date.now();
  const rulesLib = require(path.join(__dirname, "rules.js"));
  const cache = rulesLib.readCache();
  if (!cache || !cache.hits) return { ok: false, error: "ruleaza intai analiza" };

  const labels = new Map(rulesLib.RULES.map((r) => [r.id, { label: r.label, severity: r.severity }]));

  // total jobs per source
  const total = new Map();
  const solr = new Solr({ core: "job" });
  let scanned = 0;
  for await (const d of solr.scan("*:*", "url")) {
    scanned++;
    const h = hostOf(d.url);
    total.set(h, (total.get(h) || 0) + 1);
  }

  // defects per source, per rule, plus the distinct jobs affected
  const perSource = new Map();
  for (const [ruleId, urls] of Object.entries(cache.hits)) {
    for (const u of urls) {
      const h = hostOf(u);
      let e = perSource.get(h);
      if (!e) { e = { rules: {}, affected: new Set() }; perSource.set(h, e); }
      e.rules[ruleId] = (e.rules[ruleId] || 0) + 1;
      e.affected.add(u);
    }
  }

  const rows = [];
  for (const [host, jobs] of total) {
    if (jobs < minJobs) continue;
    const e = perSource.get(host) || { rules: {}, affected: new Set() };
    const affected = e.affected.size;
    const top = Object.entries(e.rules)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([id, n]) => ({
        id, n,
        label: (labels.get(id) || {}).label || id,
        severity: (labels.get(id) || {}).severity || "info",
        // share of THIS source's jobs hit by this rule - the number that says
        // whether the scraper is broken or merely imperfect
        pct: +((n / jobs) * 100).toFixed(1),
      }));
    // the full source-by-rule grid, which is what the heat map on the Surse tab
    // draws; `top` stays because the cards and the model prompt only want four
    const cells = {};
    for (const [id, n] of Object.entries(e.rules)) cells[id] = +((n / jobs) * 100).toFixed(1);

    rows.push({
      host, jobs, affected,
      affectedPct: +((affected / jobs) * 100).toFixed(1),
      totalDefects: Object.values(e.rules).reduce((a, b) => a + b, 0),
      top, cells,
    });
  }

  rows.sort((a, b) => b.affected - a.affected);

  // carry over diagnoses so a rebuild does not silently drop them
  const prev = read();
  if (prev && Array.isArray(prev.rows)) {
    const byHost = new Map(prev.rows.filter((r) => r.diagnostic).map((r) => [r.host, r.diagnostic]));
    for (const r of rows) { const d = byHost.get(r.host); if (d) r.diagnostic = d; }
  }

  const out = {
    at: new Date().toISOString(),
    diagnosedBy: (prev && prev.diagnosedBy) || null,
    seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    scanned,
    sources: rows.length,
    rows: rows.slice(0, 40),
  };
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(out), "utf8");
  return { ok: true, ...out };
}

function read() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return null; }
}

/** every job url from one source that trips a given rule, for the drawer */
function urlsFor(host, ruleId) {
  const rulesLib = require(path.join(__dirname, "rules.js"));
  const cache = rulesLib.readCache();
  if (!cache || !cache.hits || !cache.hits[ruleId]) return null;
  return cache.hits[ruleId].filter((u) => hostOf(u) === host);
}

/**
 * The model reads the defect profile of each source and says, in one sentence,
 * what is most likely wrong with that scraper. It sees only measured counts -
 * never documents - so it cannot invent a number; it is doing the one thing a
 * table cannot, which is naming the likely cause.
 */
const DIAG_INSTRUCTION = [
  "Primesti profilul de defecte al unor SURSE de joburi (scrapere) pentru peviitor.ro.",
  "Pentru fiecare sursa scrii O SINGURA propozitie in romana, cu diacritice, care spune ce e cel mai probabil in neregula cu scraperul acela.",
  "",
  "Foloseste doar cifrele primite. Nu inventa. Nu repeta procentele - explica ce inseamna.",
  "Fii concret: 'duplica fiecare anunt' e util, 'are probleme de calitate' nu este.",
  "Daca o sursa arata sanatos, spune asta scurt.",
  "",
  'Raspunde DOAR cu JSON: [{"i":0,"diagnostic":"..."},{"i":1,"diagnostic":"..."}]',
].join(String.fromCharCode(10));

async function diagnose({ max = 12 } = {}) {
  const llm = require(path.join(__dirname, "llm.js"));
  const data = read();
  if (!data || !data.rows) return { ok: false, error: "ruleaza intai analiza pe surse" };

  const rows = data.rows.slice(0, max);
  const payload = rows.map((r, i) => ({
    i,
    sursa: r.host,
    joburi: r.jobs,
    joburiAfectate: r.affected,
    procentAfectat: r.affectedPct,
    defecte: r.top.map((t) => ({ problema: t.label, joburi: t.n, procentDinSursa: t.pct })),
  }));

  let out;
  try {
    out = await llm.askBalanced({
      system: DIAG_INSTRUCTION,
      user: JSON.stringify(payload, null, 1),
      maxTokens: 1600,
      only: ["gemini", "groq", "claude"],
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  let parsed = null;
  const m = out.text.match(/\[[\s\S]*\]/);
  try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
  if (!Array.isArray(parsed)) return { ok: false, error: "raspuns neasteptat de la model", raw: out.text.slice(0, 200) };

  for (const v of parsed) {
    if (rows[v.i]) rows[v.i].diagnostic = String(v.diagnostic || "").trim();
  }
  data.diagnosedAt = new Date().toISOString();
  data.diagnosedBy = out.provider + "/" + out.model;
  fs.writeFileSync(CACHE, JSON.stringify(data), "utf8");

  return {
    ok: true, diagnosed: parsed.length, provider: out.provider + "/" + out.model,
    tokens: out.tokens, rows: rows.map((r) => ({ host: r.host, diagnostic: r.diagnostic })),
  };
}

module.exports = { build, read, urlsFor, hostOf, diagnose, CACHE };
