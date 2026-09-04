"use strict";
/**
 * lib/summary.js - the model writes the dashboard's opening paragraph.
 *
 * It is handed ONLY measured facts: the rule registry with real counts, the
 * production-parity result, and the COR coverage. It never queries the index
 * and never sees raw documents, so it cannot invent a number - everything it
 * can say is already something we measured.
 *
 * Its job is the one thing a table of 27 counts does badly: say what actually
 * matters right now, in one short Romanian paragraph, and what to do first.
 */
const path = require("path");
const fs = require("fs");

const ENV = require(path.join(__dirname, "env.js")).load();
const CACHE = path.join(__dirname, "..", "cache", "summary.json");
const BASE = (ENV.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
const KEY = ENV.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || "";
// a 4-sentence summary over pre-measured facts does not need the biggest
// model; sonnet costs a fraction and the facts are already computed
const MODEL = "claude-sonnet-5";

// Written with diacritics on purpose: a prompt spelled "in romana cu diacritice"
// while itself having none teaches the model the opposite of what it asks for,
// and every bulletin came back flat.
const SYSTEM = [
  "Scrii nota de stare a bazei de date de joburi peviitor.ro, pentru un coleg care are cinci minute.",
  "",
  "Primești DOAR fapte măsurate. Nu inventa nicio cifră. Folosește doar numerele primite.",
  "Scrie în română, cu diacritice complete: ă, â, î, ș, ț. Ton de raport intern, nu de prezentare.",
  "",
  "Trei paragrafe, fără titluri, fără liste:",
  "1. Cât de sănătoasă e baza și care e cifra care contează cel mai mult acum.",
  "2. Dacă defectele se concentrează pe câteva surse, numește-le și spune cât produce fiecare. Asta e partea utilă: o sursă reparată înseamnă mii de rânduri curate.",
  "3. Două sau trei probleme concrete, cu cifre, și ce înseamnă pentru cineva care caută un job.",
  "",
  "Reguli de scriere:",
  "- fără bold, fără emoji, fără linii de dialog;",
  "- folosește punct sau punct și virgulă, niciodată linia de pauză lungă;",
  "- nu începe propoziții cu „Este important”, „Merită menționat”, „În esență”;",
  "- o regulă cu zero înseamnă că defectul acela nu există; dacă o spui, spune-o direct („nicio etichetă nu are majuscule”), nu întoarce numele regulii pe dos;",
  "- nu enumera reguli mecanic;",
  "- nu folosi cuvintele „blocant”, „severitate”, „registru”, „materializat”, „scor compozit”;",
  "- aplicația GĂSEȘTE probleme, nu le repară: nu propune normalizări și nu vorbi despre corectarea datelor;",
  "- maximum 170 de cuvinte.",
  "Răspunde EXCLUSIV în limba română.",
].join(String.fromCharCode(10));

/** goes through lib/llm.js so the daily budget counts it like every other call */
async function callModel(userText) {
  const llm = require(path.join(__dirname, "llm.js"));
  const r = await llm.ask({
    system: SYSTEM,
    user: userText,
    maxTokens: 1400,
    order: ["claude", "gemini", "groq"],
  });
  return { text: r.text, usage: { input_tokens: r.tokens.input, output_tokens: r.tokens.output }, provider: r.provider, model: r.model };
}

/** the exact, measured picture handed to the model - nothing else */
async function facts() {
  const rules = require(path.join(__dirname, "rules.js"));
  const { total, at, rules: list } = await rules.counts();
  const score = rules.score(list).score;

  const firing = list
    .filter((r) => r.measured && r.count > 0)
    .sort((a, b) => (b.weight || 0) * (b.pct || 0) - (a.weight || 0) * (a.pct || 0))
    .slice(0, 8)
    .map((r) => ({ regula: r.label, joburi: r.count, procent: r.pct, gravitate: r.severity }));
  const firingTotal = list.filter((r) => r.measured && r.count > 0).length;

  const clean = list.filter((r) => r.measured && r.count === 0).map((r) => r.label);
  const unmeasured = list.filter((r) => !r.measured).map((r) => r.label);

  let cor = null;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cache", "cor.json"), "utf8"));
    cor = {
      potriviteProcent: c.matchedPct, joburiPotrivite: c.matchedJobs,
      titluriDistincte: c.distinctTitles,
      ambigue: c.ambiguousJobs,
      // spelled out because "ambiguu" reads like "duplicat" if you do not know
      ceInseamnaAmbigue: "titluri care se potrivesc cu mai multe ocupatii COR deodata, deci codul nu poate fi ales sigur",
    };
  } catch { /* not computed yet */ }

  let parity = null;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cache", "parity.json"), "utf8"));
    parity = { local: p.local, productie: p.prod, esantion: p.sample, gasite: p.found, procent: p.foundPct };
  } catch { /* not run yet */ }

  // nuances the raw counts do not carry, so the model does not misread them
  const note = [
    "Aplicatia GASESTE probleme, nu le repara. Nu propune normalizari si nu vorbi despre corectarea datelor - spune doar ce e in neregula si cat de mult.",
    "„Locatii doar la nivel de tara” (Romania / Remote, Romania) este corect pentru joburile remote, nu e defect.",
    "Scorul e o penalizare ponderata pe 0-100; nu inseamna procentul de joburi bune.",
    "„Joburi duplicate” inseamna acelasi titlu la aceeasi companie, de obicei din cauza scraperului.",
    "NU ai date istorice. Nu compara cu luna trecuta, cu raportul anterior sau cu o tendinta - nu exista.",
    "„problemeActive” este doar primele 8 reguli dupa impact, nu toate regulile care declanseaza; numarul lor real e in „problemeActiveTotal”.",
  ];
  // where the defects come from - the single most actionable input
  let surse = null;
  try {
    const sc = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cache", "sources.json"), "utf8"));
    surse = (sc.rows || []).slice(0, 6).map((r) => ({
      sursa: r.host, joburi: r.jobs, afectate: r.affected, procent: r.affectedPct,
      principalele: r.top.slice(0, 2).map((t) => t.label + " (" + t.n + ")"),
      diagnostic: r.diagnostic || null,
    }));
  } catch { /* not computed yet */ }

  return { totalJoburi: total, scor: score, scanatLa: at, problemeActive: firing, problemeActiveTotal: firingTotal, verificariCurate: clean, nemasurate: unmeasured, cor, paritate: parity, surse, precizari: note };
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch {}
  // a restarted container has no cache/; the snapshot carries the last bulletin
  const snap = require(path.join(__dirname, "snapshot.js")).read();
  return snap && snap.summary ? snap.summary : null;
}

/** one bulletin per day, and not one per change of state */
const MAX_AGE_MS = 20 * 60 * 60 * 1000;
function fresh(cached) {
  if (!cached || !cached.at) return false;
  return Date.now() - Date.parse(cached.at) < MAX_AGE_MS;
}

/** generate a fresh summary; `force` ignores the cache */
async function generate({ force = false } = {}) {
  const f = await facts();
  const cached = readCache();
  const stamp = JSON.stringify({ t: f.totalJoburi, s: f.scor, p: f.problemeActive });
  // The bulletin used to be rewritten whenever any of those numbers moved,
  // which on a live index meant several model calls a day for a paragraph that
  // said the same thing. It is now written once a day, or on the button.
  if (!force && fresh(cached)) return { ...cached, cached: true };
  if (!force && cached && cached.stamp === stamp) return { ...cached, cached: true };

  const llm = require(path.join(__dirname, "llm.js"));
  if (!llm.available().length) return { ok: false, error: "niciun furnizor AI configurat", facts: f };
  const budget = llm.budgetStatus();
  if (budget.exhausted) {
    // an old bulletin beats no bulletin; say plainly that it is not fresh
    if (cached) return { ...cached, cached: true, stale: true, budget };
    return { ok: false, error: "buget AI epuizat azi (" + budget.used + "/" + budget.limit + ")", facts: f, budget };
  }

  const r = await callModel(JSON.stringify(f, null, 1));
  require(path.join(__dirname, "llm.js")).assertClean(r.text);
  const out = {
    ok: true,
    text: r.text,
    at: new Date().toISOString(),
    model: MODEL,
    tokens: { input: r.usage.input_tokens || 0, output: r.usage.output_tokens || 0 },
    stamp,
    facts: f,
  };
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(out), "utf8");
  return out;
}

module.exports = { generate, facts, readCache, MODEL };
