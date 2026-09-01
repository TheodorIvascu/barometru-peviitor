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

const SYSTEM = [
  "Scrii buletinul de stare al bazei de date de joburi peviitor.ro. Il citeste cineva care are 5 minute si vrea sa stie ce se intampla.",
  "",
  "Primesti DOAR fapte masurate. Nu inventa nicio cifra. Foloseste doar numerele primite.",
  "Scrie in romana, cu diacritice, fara entuziasm si fara jargon tehnic.",
  "",
  "Structura, exact asa, cu aceste titluri:",
  "**Pe scurt** — doua propozitii: cat de sanatoasa e baza si care e cifra care conteaza cel mai mult.",
  "**Sursa problemei** — daca defectele se concentreaza pe cateva surse, NUMESTE-LE si spune cat produce fiecare. Asta e cea mai utila informatie din tot buletinul: o sursa reparata inseamna mii de randuri curate.",
  "**Merita atentie** — doua-trei probleme concrete, cu cifre, si de ce conteaza pentru cineva care cauta un job.",
  "**Ce e in regula** — o propozitie despre verificarile care trec. ATENTIE: o regula cu zero inseamna ca defectul acela NU exista. Formuleaza pozitiv si clar: daca regula «Etichete scrise cu majuscule» e zero, scrie «nicio eticheta nu are majuscule», NU «etichetele sunt minuscule». Nu intoarce numele regulii pe dos.",
  "",
  "Reguli de scriere:",
  "- foloseste **bold** doar pentru cifre si nume de surse;",
  "- nu enumera reguli mecanic, explica;",
  "- nu folosi cuvintele 'blocant', 'severitate', 'registru', 'materializat', 'scor compozit';",
  "- aplicatia GASESTE probleme, nu le repara: nu propune normalizari si nu vorbi despre corectarea datelor;",
  "- maxim 200 de cuvinte in total.",
  "Raspunde EXCLUSIV in limba romana.",
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

  const clean = list.filter((r) => r.measured && r.count === 0).map((r) => r.label);
  const unmeasured = list.filter((r) => !r.measured).map((r) => r.label);

  let cor = null;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cache", "cor.json"), "utf8"));
    cor = { potriviteProcent: c.matchedPct, joburiPotrivite: c.matchedJobs, ambigue: c.ambiguousJobs };
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

  return { totalJoburi: total, scor: score, scanatLa: at, problemeActive: firing, verificariCurate: clean, nemasurate: unmeasured, cor, paritate: parity, surse, precizari: note };
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return null; }
}

/** generate a fresh summary; `force` ignores the cache */
async function generate({ force = false } = {}) {
  const f = await facts();
  const cached = readCache();
  const stamp = JSON.stringify({ t: f.totalJoburi, s: f.scor, p: f.problemeActive });
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
