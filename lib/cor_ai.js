"use strict";
/**
 * lib/cor_ai.js - the model picks a COR code ONLY where the deterministic
 * matcher legitimately cannot.
 *
 * The matcher refuses to guess when a job title is the opening of several
 * official occupations: "Consilier vanzari" opens "consilier vânzări asigurări"
 * AND "consilier vânzări bijuterii și ceasuri". Picking one by string distance
 * would be inventing precision. A model reading the title and the candidate
 * list can often tell - and when it cannot, it says so.
 *
 * Scope guards, deliberately tight:
 *   - only titles the matcher already marked ambiguous (never the whole corpus)
 *   - candidates come from COR, so the model chooses, it does not invent a code
 *   - every verdict is cached by title + model + prompt hash, judged once
 *   - a title the model is unsure about stays unmatched, not force-fitted
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
// the project's own .env must win here: a shell that already exports
// ANTHROPIC_BASE_URL=https://api.anthropic.com would otherwise send the
// gateway token straight to Anthropic, which rejects it as an invalid key
const ENV = require(path.join(__dirname, "env.js")).load();

const llm = require(path.join(__dirname, "llm.js"));

const CACHE = path.join(__dirname, "..", "cache", "cor_ai.json");
const BASE = (ENV.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
const KEY = ENV.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || "";
const MODEL = "auto";   // whichever provider answered; recorded per entry
const BATCH = 8;

const INSTRUCTION = [
  "Alegi codul COR corect pentru titluri de job romanesti pe care un algoritm determinist le-a marcat ca AMBIGUE.",
  "Ambiguu inseamna ca titlul este inceputul mai multor ocupatii oficiale si nu este identic cu niciuna.",
  "",
  "Pentru fiecare rand primesti titlul si lista de coduri COR candidate. Alegi UNUL dintre codurile date, sau raspunzi cu null.",
  "Nu inventa coduri. Nu alege un cod care nu apare in lista candidatilor acelui rand.",
  "Raspunde cu null cand titlul e prea generic ca sa distingi intre candidati - de exemplu 'Economist' fara niciun context nu spune daca e economist banca sau economist-sef.",
  "Pe langa titlu primesti companiile care posteaza acel titlu si etichetele jobului. Foloseste-le ca sa distingi:",
  "  'Mecanic' la un dealer auto cu etichete [auto, service] este mecanic auto, nu mecanic de utilaje.",
  "Alege un candidat cand titlul SAU contextul contine un indiciu real. Daca nici contextul nu ajuta, raspunde null.",
  "",
  'Raspunde DOAR cu JSON: [{"i":0,"code":"241245"},{"i":1,"code":null}]',
].join("\n");

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return { version: 1, entries: {} }; }
}
function writeCache(c) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(c), "utf8");
}
const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
const promptHash = hash(INSTRUCTION);

/** Gemini first: this is bulk "pick one of these codes", not prose, and the
 *  free tier handles it. Claude is the fallback when Gemini is overloaded. */
async function callModel(userText) {
  // spread bulk work across all three free tiers instead of exhausting one
  const r = await llm.askBalanced({
    system: INSTRUCTION,
    user: userText,
    maxTokens: 1500,
    only: ["gemini", "groq", "claude"],
  });
  return { text: r.text, usage: { input_tokens: r.tokens.input, output_tokens: r.tokens.output }, provider: r.provider, model: r.model };
}

/**
 * @param {Array} ambiguous  [{ title, count, candidates:[{code,name}] }]
 * @param {number} max       how many titles to send at most
 */
async function resolve(ambiguous, { max = 60, onProgress } = {}) {
  if (!KEY) return { ok: false, error: "lipseste ANTHROPIC_AUTH_TOKEN in .env" };
  const cache = readCache();
  const todo = [];
  let fromCache = 0;

  const list = (ambiguous || []).slice(0, max);
  for (const row of list) {
    const key = "cor|" + hash(row.title) + "|" + MODEL + "|" + promptHash;
    if (cache.entries[key]) { fromCache++; continue; }
    todo.push({ row, key });
  }

  let calls = 0, resolved = 0, tokensIn = 0, tokensOut = 0, usedProvider = null;
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const payload = chunk.map((c, n) => ({
      i: n,
      titlu: c.row.title,
      companii: (c.row.companies || []).slice(0, 3),
      etichete: (c.row.tags || []).slice(0, 8),
      candidati: (c.row.candidates || []).map((x) => ({ code: x.code, name: x.name })),
    }));
    let parsed = null;
    try {
      const r = await callModel(JSON.stringify(payload, null, 1));
      calls++;
      usedProvider = r.provider + "/" + r.model;
      tokensIn += (r.usage.input_tokens || 0);
      tokensOut += (r.usage.output_tokens || 0);
      const m = r.text.match(/\[[\s\S]*\]/);
      parsed = m ? JSON.parse(m[0]) : null;
    } catch (e) {
      return { ok: false, error: e.message, calls, resolved, fromCache };
    }
    if (Array.isArray(parsed)) {
      for (const v of parsed) {
        const c = chunk[v.i];
        if (!c) continue;
        const allowed = new Set((c.row.candidates || []).map((x) => String(x.code)));
        const code = v.code && allowed.has(String(v.code)) ? String(v.code) : null;
        const pick = code ? (c.row.candidates.find((x) => String(x.code) === code) || null) : null;
        cache.entries[c.key] = {
          title: c.row.title, code, name: pick ? pick.name : null,
          model: MODEL, prompt: promptHash, at: new Date().toISOString(),
        };
        if (code) resolved++;
      }
    }
    if (onProgress) onProgress(Math.min(i + BATCH, todo.length), todo.length);
  }
  writeCache(cache);

  return {
    ok: true, considered: list.length, fromCache, judged: todo.length,
    resolved, calls, provider: usedProvider, tokens: { input: tokensIn, output: tokensOut },
  };
}

/** title -> { code, name } for titles the model managed to place */
function verdicts() {
  const c = readCache();
  const out = new Map();
  for (const k in c.entries) {
    const e = c.entries[k];
    if (e && e.code) out.set(e.title, { code: e.code, name: e.name });
  }
  return out;
}

/**
 * Titles COR has no wording for at all - "Consultant vanzari" when the register
 * says "agent de vânzări", "Lucrator in depozit" when it says "magaziner".
 * A regex cannot bridge that; it is a synonym, not a spelling.
 *
 * The model still may not invent: we score every occupation by shared words
 * and hand it the best few, so it chooses from the official list or says null.
 */
function candidatesFor(title, index, take = 8) {
  const cor = require(path.join(__dirname, "cor.js"));
  const fold = (x) => cor.foldKey(String(x || ""));
  const words = [...new Set(fold(title).split(/\s+/).filter((w) => w.length >= 4))];
  if (!words.length) return [];

  const scored = [];
  for (const occ of index.list) {
    const nk = fold(occ.name);
    let hit = 0;
    for (const w of words) if (nk.includes(w)) hit++;
    if (!hit) continue;
    // prefer names that share more words and are not wildly over-specified
    scored.push({ occ, score: hit - String(occ.name).length / 400 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, take).map((x) => ({ code: x.occ.code, name: x.occ.name }));
}

const UNMATCHED_INSTRUCTION = [
  "Primesti titluri de job romanesti pentru care un algoritm nu a gasit nicio ocupatie oficiala COR.",
  "Pentru fiecare primesti si o lista de ocupatii CANDIDATE din registrul oficial.",
  "",
  "Alegi UNUL dintre codurile date daca descrie aceeasi meserie, chiar daca e formulat altfel.",
  "Exemple de echivalente reale: 'Consultant vanzari' = 'agent de vanzari'; 'Lucrator in depozit' = 'magaziner'.",
  "Raspunzi null daca niciun candidat nu descrie aceeasi meserie, sau daca titlul e prea vag.",
  "",
  "Nu inventa coduri. Nu alege un cod care nu apare in lista acelui rand.",
  "Nu alege doar pentru ca un cuvant se repeta - meseria trebuie sa fie aceeasi.",
  'Raspunde DOAR cu JSON: [{"i":0,"code":"332203"},{"i":1,"code":null}]',
].join(String.fromCharCode(10));

/**
 * @param {Array} unmatched [{ title, count, companies?, tags? }]
 */
async function resolveUnmatched(unmatched, { max = 60, onProgress } = {}) {
  const cor = require(path.join(__dirname, "cor.js"));
  const index = cor.loadCor();
  const cache = readCache();

  const list = (unmatched || []).slice(0, max);
  const todo = [];
  let fromCache = 0;
  for (const row of list) {
    const key = "unm|" + hash(row.title) + "|" + MODEL + "|" + hash(UNMATCHED_INSTRUCTION);
    if (cache.entries[key]) { fromCache++; continue; }
    const cands = candidatesFor(row.title, index);
    if (!cands.length) continue;                 // nothing plausible to offer
    todo.push({ row, key, cands });
  }

  let calls = 0, resolved = 0, tokensIn = 0, tokensOut = 0, provider = null;
  for (let i = 0; i < todo.length; i += 8) {
    const chunk = todo.slice(i, i + 8);
    const payload = chunk.map((c, n) => ({
      i: n,
      titlu: c.row.title,
      companii: (c.row.companies || []).slice(0, 2),
      candidati: c.cands,
    }));
    let parsed = null;
    try {
      const r = await llm.askBalanced({
        system: UNMATCHED_INSTRUCTION,
        user: JSON.stringify(payload, null, 1),
        maxTokens: 1200,
        only: ["gemini", "groq", "claude"],
      });
      calls++;
      provider = r.provider + "/" + r.model;
      tokensIn += r.tokens.input; tokensOut += r.tokens.output;
      const m = r.text.match(/\[[\s\S]*\]/);
      parsed = m ? JSON.parse(m[0]) : null;
    } catch (e) {
      return { ok: false, error: e.message, calls, resolved, fromCache };
    }
    if (Array.isArray(parsed)) {
      for (const v of parsed) {
        const c = chunk[v.i];
        if (!c) continue;
        const allowed = new Map(c.cands.map((x) => [String(x.code), x.name]));
        const code = v.code && allowed.has(String(v.code)) ? String(v.code) : null;
        cache.entries[c.key] = {
          title: c.row.title, code, name: code ? allowed.get(code) : null,
          kind: "unmatched", model: MODEL, at: new Date().toISOString(),
        };
        if (code) resolved++;
      }
    }
    if (onProgress) onProgress(Math.min(i + 8, todo.length), todo.length);
  }
  writeCache(cache);
  return { ok: true, considered: list.length, judged: todo.length, fromCache, resolved, calls, provider,
           tokens: { input: tokensIn, output: tokensOut } };
}

module.exports = { resolve, resolveUnmatched, verdicts, readCache, MODEL };
