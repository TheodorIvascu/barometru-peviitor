"use strict";
/**
 * ANAF CIF verification.
 *
 * Official free service, no API key:
 *   POST https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva
 *   body: [{ "cui": 21445907, "data": "2026-08-20" }]
 *
 * Published limits: max 100 CUI per request, max 1 request per second.
 * Both are enforced here via lib/ratelimit.js.
 */
const fs = require("fs");
const path = require("path");
const { RateLimiter, fetchRetry } = require(path.join(__dirname, "ratelimit.js"));

const ENDPOINT = "https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva";
const BATCH = 100;
const CACHE = path.join(__dirname, "..", "cache", "anaf.json");

const limiter = new RateLimiter(1, 1); // exactly their published limit

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return {}; }
}
function saveCache(c) {
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(c, null, 1));
  } catch {}
}

/** a CIF is structurally valid when it is 2-10 digits with a correct check digit */
function isStructurallyValid(cif) {
  const s = String(cif).replace(/^RO/i, "").trim();
  if (!/^\d{2,10}$/.test(s)) return false;
  if (Number(s) === 0) return false;
  const key = "753217532";
  const digits = s.slice(0, -1).padStart(9, "0");
  const control = Number(s.slice(-1));
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(digits[i]) * Number(key[i]);
  let r = (sum * 10) % 11;
  if (r === 10) r = 0;
  return r === control;
}

/** verify a list of CIFs against ANAF; cached, rate limited, resumable */
async function verify(cifs, opts = {}) {
  const { onProgress, useCache = true, date = new Date().toISOString().slice(0, 10) } = opts;
  const cache = useCache ? loadCache() : {};
  const clean = [...new Set(cifs.map((c) => String(c).replace(/^RO/i, "").trim()).filter((c) => /^\d+$/.test(c) && Number(c) > 0))];
  const todo = clean.filter((c) => !cache[c]);
  const out = {};
  for (const c of clean) if (cache[c]) out[c] = cache[c];

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const body = JSON.stringify(batch.map((cui) => ({ cui: Number(cui), data: date })));
    try {
      const res = await limiter.run(() =>
        fetchRetry(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }, { retries: 2, timeoutMs: 20000 })
      );
      const j = await res.json();
      for (const f of j.found || []) {
        const g = f.date_generale || {};
        const cui = String(g.cui);
        out[cui] = cache[cui] = {
          found: true,
          name: g.denumire || null,
          address: g.adresa || null,
          status: g.stare_inregistrare || null,
          vat: !!(f.inregistrare_scop_Tva && f.inregistrare_scop_Tva.scpTVA),
          checked: date,
        };
      }
      for (const nf of j.notfound || []) {
        const cui = String(nf.cui !== undefined ? nf.cui : nf);
        out[cui] = cache[cui] = { found: false, checked: date };
      }
    } catch (e) {
      for (const c of batch) out[c] = { error: e.message.slice(0, 80) };
    }
    onProgress && onProgress(Math.min(i + BATCH, todo.length), todo.length, limiter.stats);
  }
  if (useCache) saveCache(cache);
  return out;
}

module.exports = { verify, isStructurallyValid, limiter, ENDPOINT, BATCH };
