"use strict";
/**
 * Enrichment: derived fields computed once per run for every document, kept
 * beside the index and never written back to it. Both the checks and the
 * statistics read these; neither computes anything on its own.
 */
const { classify, countyFor } = require("./locations.js");
const { cifKey } = require("./cif.js");

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const str = (v) => (v == null ? "" : Array.isArray(v) ? String(v[0] == null ? "" : v[0]) : String(v));

function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, "").toLowerCase(); } catch { return "(url invalid)"; }
}

/** lowercase, trimmed, one space between words, HTML entities for & decoded */
function normTitle(t) {
  return str(t).replace(/&amp;/gi, "&").toLowerCase().replace(/\s+/g, " ").trim();
}

function ageDays(iso, now) {
  if (!iso) return null;
  const t = Date.parse(str(iso));
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 86400000);
}

/**
 * @param doc   raw Solr job document
 * @param ctx   { index, companies: Map(cifKey -> {name, status}), now }
 */
function enrichJob(doc, ctx) {
  const location = asArray(doc.location).map(String);
  const rawLoc = location.join(", ");
  const loc = classify(rawLoc, ctx.index);
  const county = countyFor(rawLoc, loc, ctx.index);

  const ck = cifKey(doc.cif);
  const co = ck ? ctx.companies.get(ck) || null : null;

  return {
    url: str(doc.url),
    title: str(doc.title),
    company: str(doc.company),
    cif: str(doc.cif),
    location,
    tags: asArray(doc.tags).map(String),
    workmode: str(doc.workmode),
    date: str(doc.date),
    status: str(doc.status),
    vdate: str(doc.vdate),
    expirationdate: str(doc.expirationdate),
    salary: doc.salary == null ? "" : doc.salary,      // kept as stored: the contract wants a string, the index may hold an array

    host: hostOf(doc.url),
    cifKey: ck,
    co,                                                  // the company document this job points at, or null
    loc: { kind: loc.kind, value: loc.value || "", how: loc.how, county: county || "" },
    age: ageDays(doc.date, ctx.now),
    ntitle: normTitle(doc.title),
    dupIndex: 0,                                         // 0 = first (or only) copy of this title+company; filled in run.js
    issues: [],                                          // filled by checks
    link: "",                                            // filled by the link probe on sampled jobs
  };
}

function enrichCompany(doc) {
  return {
    id: str(doc.id),
    key: cifKey(doc.id),
    name: str(doc.company),
    status: str(doc.status),
    lastScraped: str(doc.lastScraped),          // when the catalogue last asked ANAF about this company
    scraperFile: str(doc.scraperFile),
    jobs: 0,                                             // filled after the job scan
  };
}

module.exports = { enrichJob, enrichCompany };
