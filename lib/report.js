"use strict";
/**
 * lib/report.js - the long analysis, written once a day, printed as a PDF.
 *
 * The bulletin on the dashboard is three paragraphs for someone passing by.
 * This is the other thing: several pages, meant to be sent to whoever maintains
 * a scraper, with the numbers laid out underneath so nothing has to be taken on
 * faith. The model writes the prose; every table under it is measured.
 *
 * There is no PDF library here on purpose. The report is served as a page that
 * knows how to print itself, and the browser writes the PDF - which is the same
 * renderer the reader already trusts, costs nothing, and keeps the image from
 * carrying a headless browser it would use once a day.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CACHE = path.join(ROOT, "cache", "report.json");
const MAX_AGE_MS = 22 * 60 * 60 * 1000;

// Written with diacritics on purpose - see the note in lib/summary.js.
const SYSTEM = [
  "Scrii raportul de calitate a datelor pentru baza de joburi peviitor.ro.",
  "Îl citește cine întreține scraperele și cine decide ce se repară luna asta.",
  "",
  "Primești DOAR fapte măsurate. Nu inventa nicio cifră. Folosește doar numerele primite.",
  "Scrie în română, cu diacritice complete: ă, â, î, ș, ț. Persoana a treia, ton de raport intern.",
  "",
  "Structura, cu exact aceste titluri, fiecare pe rând propriu, precedat de ##:",
  "## Situația",
  "## Unde se concentrează defectele",
  "## Ce înseamnă pentru cine caută un job",
  "## De unde s-ar începe",
  "",
  "Sub fiecare titlu, două-patru paragrafe. Fără liste cu bulină, fără tabele:",
  "tabelele sunt deja tipărite sub text și nu trebuie repetate.",
  "",
  "Reguli de scriere:",
  "- fără bold, fără emoji;",
  "- folosește punct sau punct și virgulă, niciodată linia de pauză lungă;",
  "- nu începe propoziții cu „Este important”, „Merită menționat”, „În esență”;",
  "- o regulă cu zero înseamnă că defectul acela nu există;",
  "- aplicația GĂSEȘTE probleme, nu le repară: la „De unde s-ar începe” vorbești",
  "  despre ce sursă merită investigată prima, nu despre normalizări sau corecții;",
  "- fii concret: numește sursele și spune câte rânduri sunt în joc;",
  "- nu ai date istorice: nu scrie „față de luna trecută”, „a treia oară consecutiv”,",
  "  „rămân aceleași de la ultimul raport” sau orice altceva care presupune o măsurătoare anterioară;",
  "- nu explica un termen ghicind: dacă faptele spun ce înseamnă un câmp, folosește acea explicație;",
  "- între 600 și 900 de cuvinte.",
  "Răspunde EXCLUSIV în limba română.",
].join(String.fromCharCode(10));

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function read() {
  const live = readJson(CACHE);
  if (live) return live;
  const snap = require(path.join(__dirname, "snapshot.js")).read();
  return snap && snap.report ? snap.report : null;
}

function fresh(c) {
  return !!(c && c.at && Date.now() - Date.parse(c.at) < MAX_AGE_MS);
}

/** every table the printed report shows, measured, no model involved */
async function tables() {
  const rules = require(path.join(__dirname, "rules.js"));
  const { total, at, rules: list } = await rules.counts();
  const s = rules.score(list);

  const cor = readJson(path.join(ROOT, "cache", "cor.json"))
    || (require(path.join(__dirname, "snapshot.js")).read() || {}).cor || null;
  const sources = readJson(path.join(ROOT, "cache", "sources.json"))
    || (require(path.join(__dirname, "snapshot.js")).read() || {}).sources || null;

  return {
    total, at, score: s.score, measured: s.measured, ofRules: s.of,
    rules: list,
    sources: sources && sources.rows ? sources.rows.slice(0, 15) : [],
    cor: cor ? {
      matchedPct: cor.matchedPct, matchedJobs: cor.matchedJobs,
      distinctTitles: cor.distinctTitles, ambiguousJobs: cor.ambiguousJobs,
      top: (cor.topOccupations || []).slice(0, 12),
    } : null,
  };
}

/**
 * Write the report. Called by the daily run, never from a request: the prose
 * costs a model call and the numbers under it change once a day anyway.
 */
async function generate({ force = false } = {}) {
  const cached = read();
  if (!force && fresh(cached)) return { ...cached, cached: true };

  const summary = require(path.join(__dirname, "summary.js"));
  const f = await summary.facts();

  const llm = require(path.join(__dirname, "llm.js"));
  if (!llm.available().length) return { ok: false, error: "niciun furnizor AI configurat" };
  const budget = llm.budgetStatus();
  if (budget.exhausted) {
    if (cached) return { ...cached, cached: true, stale: true };
    return { ok: false, error: "buget AI epuizat azi (" + budget.used + "/" + budget.limit + ")" };
  }

  const r = await llm.ask({
    system: SYSTEM,
    user: JSON.stringify(f, null, 1),
    maxTokens: 3000,
    order: ["claude", "gemini", "groq"],
  });

  llm.assertClean(r.text);

  const out = {
    ok: true,
    text: r.text,
    at: new Date().toISOString(),
    provider: r.provider,
    model: r.model,
  };
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(out), "utf8");
  return out;
}

module.exports = { generate, read, tables, MAX_AGE_MS };
