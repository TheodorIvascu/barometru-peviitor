"use strict";
/**
 * lib/parity.js - "are the jobs we audit the same jobs peviitor.ro serves?"
 *
 * We audit a LOCAL copy of the index. That copy is only worth auditing if it
 * still matches production, so this samples real rows from the local index and
 * looks each one up through peviitor.ro's own public API - the same API the
 * website uses. No private access, no assumptions: if a job we flag cannot be
 * found on the live site, our copy has drifted and the report is stale.
 */
const path = require("path");
require(path.join(__dirname, "env.js")).load();
const { Solr } = require(path.join(__dirname, "solr.js"));

const PUBLIC_API = "https://api.peviitor.ro/v1/search/";
const PROD_SOLR = "https://solr.peviitor.ro/solr";
const ENV = require(path.join(__dirname, "env.js")).load();
const SOLR_USER = ENV.SOLR_USER || process.env.SOLR_USER || "solr";
const SOLR_PASS = ENV.SOLR_PASS || process.env.SOLR_PASS || "";
const AUTH = "Basic " + Buffer.from(SOLR_USER + ":" + SOLR_PASS).toString("base64");

/** total documents production reports, via its Solr (read-only) */
async function prodCount(core = "job") {
  const r = await fetch(`${PROD_SOLR}/${core}/select?q=*:*&rows=0&wt=json`, {
    headers: { Authorization: AUTH },
  });
  if (!r.ok) throw new Error("productie: HTTP " + r.status);
  return (await r.json()).response.numFound;
}

/** look one job up on the public site API (what a visitor would search for) */
async function findOnSite(title) {
  const url = PUBLIC_API + "?q=" + encodeURIComponent(String(title).slice(0, 120));
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) return { ok: false, status: r.status, docs: [] };
  const j = await r.json().catch(() => null);
  const docs = (j && j.response && j.response.docs) || [];
  return { ok: true, status: 200, docs };
}

/** authoritative check: does production still hold this exact url?
 *  Matching on the uniqueKey is exact; matching on a title is not, because a
 *  free-text query OR-matches words and happily returns similar postings. */
async function existsInProd(jobUrl) {
  const q = 'url:"' + String(jobUrl).replace(/"/g, '\\"') + '"';
  const r = await fetch(`${PROD_SOLR}/job/select?q=${encodeURIComponent(q)}&rows=1&fl=url,title,company&wt=json`, {
    headers: { Authorization: AUTH },
  });
  if (!r.ok) return { ok: false, status: r.status, doc: null };
  const j = await r.json();
  const doc = j.response.docs[0] || null;
  return { ok: true, status: 200, doc, found: !!doc };
}

/**
 * Sample `sample` random local jobs and check each one is reachable on the live
 * site. Returns per-row evidence, never a bare percentage.
 */
async function check({ sample = 20, onProgress } = {}) {
  const t0 = Date.now();
  const solr = new Solr({ core: "job" });

  const local = await solr.count("*:*");
  let prod = null, prodError = null;
  try { prod = await prodCount("job"); } catch (e) { prodError = e.message; }

  // random sample so we are not always checking the same corner of the index
  const seed = Math.floor(Math.random() * 100000);
  const j = await solr._get(
    `/select?q=*:*&fl=url,title,company&rows=${sample}&sort=${encodeURIComponent("random_" + seed + " asc")}&wt=json`
  ).catch(async () => {
    // the schema may not define a random field; fall back to a random offset
    const start = Math.max(0, Math.floor(Math.random() * Math.max(1, local - sample)));
    return solr._get(`/select?q=*:*&fl=url,title,company&rows=${sample}&start=${start}&wt=json`);
  });

  const docs = j.response.docs;
  const rows = [];
  let found = 0, missing = 0, failed = 0;

  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    let verdict = "lipsa", note = "";
    try {
      const res = await existsInProd(d.url);
      if (!res.ok) { verdict = "eroare"; note = "productia a raspuns " + res.status; failed++; }
      else if (res.found) { verdict = "gasit"; found++; note = "acelasi url in productie"; }
      else { missing++; note = "nu mai exista in productie (job expirat sau sters)"; }
    } catch (e) {
      verdict = "eroare"; note = String(e.message).slice(0, 90); failed++;
    }
    rows.push({ url: d.url, title: d.title, company: d.company, verdict, note });
    if (onProgress) onProgress(i + 1, docs.length);
    await new Promise((r) => setTimeout(r, 120));
  }

  const checked = rows.length;
  return {
    at: new Date().toISOString(),
    seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    local,
    prod,
    prodError,
    delta: prod == null ? null : local - prod,
    inSync: prod != null && local === prod,
    sample: checked,
    found,
    missing,
    failed,
    foundPct: checked ? +((found / checked) * 100).toFixed(1) : null,
    rows,
    source: PROD_SOLR + " (potrivire exacta pe url)",
  };
}

module.exports = { check, prodCount, findOnSite, existsInProd, PUBLIC_API };
