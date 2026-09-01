"use strict";
/**
 * lib/ai_tasks.js - which model does which job, and where a model is the wrong
 * tool entirely.
 *
 * Routing is by the shape of the work, not by which key is newest:
 *
 *   gemini  - bulk, structured, "pick one of these". Free tier, fast, and the
 *             answer is a code, not prose. COR disambiguation, junk-location
 *             recovery.
 *   groq    - same shape as gemini, used as the overflow when a free tier
 *             rate-limits mid-run.
 *   claude  - things a person reads: the dashboard bulletin, the assistant,
 *             adjudicating adult content where a wrong call is embarrassing.
 *
 * Explicitly NOT sent to a model, because a deterministic fix is exact and
 * free:
 *   - HTML entities in titles and company names  -> decode them
 *   - company names that are not uppercase       -> uppercase them
 *   - tags carrying diacritics                   -> fold them
 *   - CIFs that fail the checksum                -> arithmetic, not judgement
 *   Using an LLM for those would be slower, cost money, and be less correct.
 */
const path = require("path");
const fs = require("fs");
const llm = require(path.join(__dirname, "llm.js"));

const ROUTES = {
  cor_ambiguous: { order: ["gemini", "groq", "claude"], why: "volum mare, raspuns structurat" },
  loc_junk:      { order: ["gemini", "groq", "claude"], why: "volum mic, raspuns structurat" },
  title_adult:   { order: ["claude", "gemini"],         why: "decizie sensibila, citita de om" },
  bulletin:      { order: ["claude", "gemini"],         why: "proza in romana, citita de om" },
  assistant:     { order: ["claude"],                   why: "are unelte si context de conversatie" },
};

const DETERMINISTIC = [
  { task: "HTML in titluri si nume de companii", fix: "decodare entitati", why: "exact si gratuit" },
  { task: "companii care nu sunt cu majuscule", fix: "toUpperCase", why: "contractul cere uppercase" },
  { task: "etichete cu diacritice", fix: "pliere diacritice", why: "transformare mecanica" },
  { task: "CIF invalid", fix: "cifra de control oficiala", why: "aritmetica, nu judecata" },
  { task: "duplicate titlu+companie", fix: "grupare exacta", why: "egalitate de siruri" },
];

const CACHE = path.join(__dirname, "..", "cache", "loc_ai.json");

const LOC_INSTRUCTION = [
  "Primesti valori de locatie dintr-un index de joburi din Romania pe care un algoritm nu le-a putut potrivi cu registrul oficial SIRUTA.",
  "Pentru fiecare valoare spui daca ascunde totusi o localitate REALA din Romania si care este.",
  "",
  'raspuns: {"i":0,"localitate":"Cluj-Napoca"} daca valoarea indica o localitate reala din Romania,',
  '         {"i":0,"localitate":null} daca nu indica nicio localitate (ex: "all", "Nespecificat", "Toate", coduri interne, nume de tara).',
  "",
  "Nu inventa. Nu ghici dupa numele companiei. Daca valoarea e o adresa, extrage doar localitatea din ea.",
  "Scrie numele oficial romanesc, cu diacritice.",
  'Raspunde DOAR cu JSON: [{"i":0,"localitate":"Cluj-Napoca"},{"i":1,"localitate":null}]',
].join("\n");

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return { version: 1, entries: {} }; }
}
function writeCache(c) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(c), "utf8");
}

/**
 * Recover real localities from the junk bucket. The matcher refuses anything it
 * cannot find in SIRUTA, which is right - but some of those values are real
 * places written oddly. This asks a model, then re-checks every answer against
 * SIRUTA, so a hallucinated town is thrown away rather than trusted.
 */
async function recoverJunkLocations({ max = 60 } = {}) {
  const { Solr } = require(path.join(__dirname, "solr.js"));
  const { loadIndex, classify } = require(path.join(__dirname, "locations.js"));

  let derived = {};
  try {
    derived = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cache", "locations.json"), "utf8")).derived || {};
  } catch { return { ok: false, error: "ruleaza intai clasificarea locatiilor" }; }

  // distinct junk values, most common first
  const tally = new Map();
  const solr = new Solr({ core: "job" });
  for await (const d of solr.scan("*:*", "url,location")) {
    const e = derived[d.url];
    if (!e || e.kind !== "junk") continue;
    for (const v of (Array.isArray(d.location) ? d.location : [d.location]).filter(Boolean)) {
      tally.set(String(v), (tally.get(String(v)) || 0) + 1);
    }
  }
  const values = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, max);
  if (!values.length) return { ok: true, considered: 0, recovered: 0, calls: 0 };

  const cache = readCache();
  const todo = values.filter(([v]) => !cache.entries[v]);
  let calls = 0, tokensIn = 0, tokensOut = 0, provider = null;

  for (let i = 0; i < todo.length; i += 12) {
    const chunk = todo.slice(i, i + 12);
    const payload = chunk.map(([v, n], k) => ({ i: k, valoare: v, joburi: n }));
    let parsed = null;
    try {
      const r = await llm.askBalanced({
        system: LOC_INSTRUCTION,
        user: JSON.stringify(payload, null, 1),
        maxTokens: 1200,
        only: ROUTES.loc_junk.order,
      });
      calls++;
      provider = r.provider + "/" + r.model;
      tokensIn += r.tokens.input; tokensOut += r.tokens.output;
      const m = r.text.match(/\[[\s\S]*\]/);
      parsed = m ? JSON.parse(m[0]) : null;
    } catch (e) {
      return { ok: false, error: e.message, calls };
    }
    if (Array.isArray(parsed)) {
      const index = loadIndex(path.join(__dirname, ".."));
      for (const row of parsed) {
        const entry = chunk[row.i];
        if (!entry) continue;
        const [value, count] = entry;
        let accepted = null, reason = "model a raspuns null";
        if (row.localitate) {
          // the model proposes, SIRUTA decides - a town it invented is dropped
          const c = classify(String(row.localitate), index);
          if (c && c.kind === "fixed" && c.value) { accepted = c.value; reason = "confirmat in SIRUTA"; }
          else reason = "propunerea „" + row.localitate + "” nu exista in SIRUTA";
        }
        cache.entries[value] = { value, count, proposed: row.localitate || null, accepted, reason, at: new Date().toISOString() };
      }
    }
  }
  writeCache(cache);

  const all = Object.values(cache.entries);
  return {
    ok: true,
    considered: values.length,
    judged: todo.length,
    fromCache: values.length - todo.length,
    recovered: all.filter((e) => e.accepted).length,
    rejected: all.filter((e) => e.proposed && !e.accepted).length,
    calls, provider,
    tokens: { input: tokensIn, output: tokensOut },
    rows: all.filter((e) => e.accepted).sort((a, b) => b.count - a.count).slice(0, 40),
  };
}

/** what runs where, for the UI to show honestly */
function routing() {
  const have = llm.available();
  return {
    providers: have,
    routes: Object.entries(ROUTES).map(([task, r]) => ({
      task, order: r.order, why: r.why,
      activ: r.order.find((p) => have.includes(p)) || null,
    })),
    deterministic: DETERMINISTIC,
  };
}

module.exports = { ROUTES, DETERMINISTIC, routing, recoverJunkLocations, readCache };
