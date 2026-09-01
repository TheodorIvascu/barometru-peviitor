"use strict";
/**
 * HTTP-facing handlers for SOLR DOCTOR.
 *
 * Every handler here is READ ONLY except postNormalize, which itself never
 * touches Solr directly - it shells out to `node doctor.js normalize --apply`
 * (the same script the terminal tool uses) and only after the caller has
 * confirmed the write.
 *
 * Reuses, never reimplements, the existing engines:
 *   lib/solr.js       raw Solr access (count/sample/facet/scan)
 *   lib/locations.js  SIRUTA location classification
 *   lib/cor.js        COR occupation matching
 *   lib/anaf.js       CIF checksum + ANAF verification
 *   lib/links.js      link health checking
 *   lib/analytics.js  the cached terminal-dashboard aggregate (10 min TTL)
 *
 * A few things analytics.js does not expose through its six public
 * functions (per-field validity, COR distribution, salary buckets for a
 * chart, HTML-entity detection in company names, dead-link roll-ups) are
 * built here directly from lib/solr.js primitives (count/facet/scan), using
 * the exact same bounded, paged patterns analytics.js and doctor.js already
 * use - never a full in-memory load of the index. Every such scan is
 * TTL-cached below so repeat requests are instant.
 *
 * NOTE on Solr field types (checked live against the schema): url/company/
 * cif/workmode/status are `string` (facet returns whole values, safe for
 * exact-match classification). title/location/tags/salary are
 * `text_general` (tokenized) - faceting those would return individual
 * words, not whole values, so those fields are read via solr.scan (stored
 * value retrieval, unaffected by analysis) instead of facet.
 */
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { Solr } = require(path.join(__dirname, "..", "lib", "solr.js"));
const locationsLib = require(path.join(__dirname, "..", "lib", "locations.js"));
const corLib = require(path.join(__dirname, "..", "lib", "cor.js"));
const anafLib = require(path.join(__dirname, "..", "lib", "anaf.js"));
const linksLib = require(path.join(__dirname, "..", "lib", "links.js"));
const analytics = require(path.join(__dirname, "..", "lib", "analytics.js"));
const { ask } = require(path.join(__dirname, "assistant.js"));

const ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------
// Solr singletons + lazily-loaded classification indexes
// ---------------------------------------------------------------------
let _job = null, _company = null;
const job = () => (_job = _job || new Solr());
const company = () => (_company = _company || new Solr({ core: "company" }));

let _locIndex = null, _corIndex = null;
const getLocIndex = () => (_locIndex = _locIndex || locationsLib.loadIndex(ROOT));
const getCorIndex = () => (_corIndex = _corIndex || corLib.loadCor());

// ---------------------------------------------------------------------
// generic in-memory TTL cache, with in-flight de-duplication so two
// concurrent requests for the same expensive thing share one build
// ---------------------------------------------------------------------
const _cache = new Map();   // key -> { data, builtAt, generatedAt }
const _building = new Map(); // key -> Promise

async function cached(key, ttlMs, builder) {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && now - hit.builtAt < ttlMs) {
    return { data: hit.data, generatedAt: hit.generatedAt, cacheAgeMs: now - hit.builtAt, fromCache: true };
  }
  if (_building.has(key)) return _building.get(key);
  const p = (async () => {
    try {
      const data = await builder();
      const generatedAt = new Date().toISOString();
      _cache.set(key, { data, builtAt: Date.now(), generatedAt });
      return { data, generatedAt, cacheAgeMs: 0, fromCache: false };
    } finally {
      _building.delete(key);
    }
  })();
  _building.set(key, p);
  return p;
}

// ---------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------
function round(n, d = 2) {
  if (n === null || n === undefined || !isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
function pct(n, total) {
  if (!total) return 0;
  return round((n / total) * 100, 2);
}
function phraseQuery(field, value) {
  const esc = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return field + ':"' + esc + '"';
}

const FIELD_NAMES = ["url", "title", "company", "cif", "location", "tags", "workmode", "salary", "date", "status"];
const ENTITY_RE = /&(amp|quot|lt|gt|#39|apos|nbsp);/i;
const WORKMODE_VALID = new Set(["remote", "hybrid", "onsite", "on-site", "hibrid", "la birou", "de acasa", "de-acasa"]);

// =======================================================================
// GET /api/health
// =======================================================================
async function getHealth() {
  const t0 = Date.now();
  let reachable = false, jobs = null, companies = null, err = null;
  try {
    reachable = await job().ping();
    if (reachable) {
      const [j, c] = await Promise.all([
        job().count("*:*"),
        company().count("*:*").catch(() => null),
      ]);
      jobs = j; companies = c;
    }
  } catch (e) {
    err = e.message;
  }
  return {
    status: reachable ? 200 : 503,
    body: {
      ok: reachable,
      solr: { reachable, url: job().url, companyUrl: company().url, error: err },
      counts: { jobs, companies },
      uptimeSeconds: Math.round(process.uptime()),
      checkedInMs: Date.now() - t0,
      timestamp: new Date().toISOString(),
    },
  };
}

// =======================================================================
// GET /api/overview
// =======================================================================
async function buildFieldCoverage() {
  return cached("fieldCoverage", 30_000, async () => {
    const solr = job();
    const total = await solr.count("*:*");
    const pairs = await Promise.all(FIELD_NAMES.map(async (f) => [f, await solr.count(f + ":*")]));
    const coverage = {};
    for (const [f, n] of pairs) coverage[f] = { filled: n, pct: pct(n, total) };
    return { total, coverage };
  });
}

async function getOverview() {
  const [ov, fc] = await Promise.all([analytics.overview(), buildFieldCoverage()]);
  return {
    status: 200,
    body: {
      jobs: ov.jobs,
      companies: ov.companies,
      verified: ov.verified,
      unverified: ov.unverified,
      international: ov.international,
      junk: ov.junk,
      distinctLocalities: ov.distinctLocalities,
      distinctCompanies: ov.distinctCompanies,
      fieldCoverage: fc.data.coverage,
      _meta: {
        analyticsGeneratedAt: ov.generatedAt,
        fieldCoverageGeneratedAt: fc.generatedAt,
        fieldCoverageCacheAgeMs: fc.cacheAgeMs,
      },
    },
  };
}

// =======================================================================
// GET /api/fields
// =======================================================================
async function buildSalaryBuckets() {
  // Simplified, regex-only pass across salary+title (a subset of the same
  // fields analytics.js's careful unit-aware parser reads) purely to bucket
  // amounts for a chart. analytics.salaryStats() already gives the
  // authoritative avg/median/min/max (hour/day-rate and deposit aware) -
  // this exists only because that summary doesn't expose a distribution.
  const CURRENCY_RE = /(\d[\d.,]{1,6})\s*(?:[-–]\s*(\d[\d.,]{1,6})\s*)?(RON|lei|EUR|EURO|€|\$|USD)\b/i;
  const BUCKETS = [[0, 2000], [2000, 3000], [3000, 4000], [4000, 5000], [5000, 7000], [7000, 10000], [10000, Infinity]];
  const label = ([a, b]) => (b === Infinity ? `${a}+` : `${a}-${b}`);

  const solr = job();
  const counts = BUCKETS.map(() => 0);
  let parseableCount = 0, scanned = 0;
  for await (const d of solr.scan("*:*", "salary,title", 2000)) {
    scanned++;
    const raws = [];
    if (Array.isArray(d.salary)) raws.push(...d.salary);
    else if (d.salary) raws.push(d.salary);
    if (d.title) raws.push(d.title);
    for (const raw of raws) {
      const m = CURRENCY_RE.exec(String(raw));
      if (!m) continue;
      const min = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
      if (!isFinite(min) || min <= 0) continue;
      parseableCount++;
      const currency = m[3].toUpperCase();
      if (currency === "RON" || currency === "LEI") {
        for (let i = 0; i < BUCKETS.length; i++) {
          const [a, b] = BUCKETS[i];
          if (min >= a && min < b) { counts[i]++; break; }
        }
      }
      break; // one amount per doc is enough for a bucket chart
    }
  }
  return { scanned, parseableCount, buckets: BUCKETS.map((b, i) => ({ range: label(b), count: counts[i] })) };
}
function getSalaryBuckets() { return cached("salaryBuckets", 10 * 60_000, buildSalaryBuckets); }

async function buildFieldsReport() {
  return cached("fields", 45_000, async () => {
    const solr = job();
    const total = await solr.count("*:*");
    const filled = {};
    await Promise.all(FIELD_NAMES.map(async (f) => { filled[f] = await solr.count(f + ":*"); }));
    const report = {};

    // url - string field, exact prefix check on the whole stored value
    {
      const validN = filled.url ? await solr.count("url:http*") : 0;
      const bad = filled.url - validN;
      report.url = {
        filled: filled.url, filledPct: pct(filled.url, total),
        valid: validN, validPct: pct(validN, filled.url || 0),
        problems: bad > 0 ? [{ type: "not-http", n: bad }] : [],
      };
    }

    // title - tokenized field, can't facet whole values. shoutingTitles.n
    // from analytics.warnings() is an exact total; other weird-title
    // reasons (too-short/too-long/punctuation-spam) are only available as
    // examples (up to 50), not totals - labelled honestly below rather
    // than duplicating analytics.js's internal detection logic here.
    {
      const w = await analytics.warnings();
      const shoutingN = w.shoutingTitles.n;
      report.title = {
        filled: filled.title, filledPct: pct(filled.title, total),
        valid: Math.max(filled.title - shoutingN, 0),
        validPct: pct(Math.max(filled.title - shoutingN, 0), filled.title || 0),
        problems: [
          { type: "shouting", n: shoutingN, note: "exact count - ALL CAPS titles" },
          {
            type: "other-weird", n: null,
            note: "too-short / too-long / punctuation-spam are not exhaustively counted here (title is a tokenized field, so it cannot be faceted for whole-string checks); see examples",
            examples: w.weirdTitles.filter((x) => x.reason !== "shouting").slice(0, 5),
          },
        ],
      };
    }

    // company - string field, facet gives whole raw values
    {
      const facet = await solr.facet("company", "*:*", 5000);
      let entityDocs = 0;
      const examples = [];
      for (const f of facet) {
        if (ENTITY_RE.test(f.value)) {
          entityDocs += f.count;
          if (examples.length < 5) examples.push({ value: f.value, count: f.count });
        }
      }
      report.company = {
        filled: filled.company, filledPct: pct(filled.company, total),
        valid: filled.company - entityDocs, validPct: pct(filled.company - entityDocs, filled.company || 0),
        problems: entityDocs ? [{ type: "html-entities-in-name", n: entityDocs, examples }] : [],
      };
    }

    // cif - string field, facet gives whole values; checksum via lib/anaf.js
    {
      const facet = await solr.facet("cif", "*:*", 5000);
      let validN = 0, zeroN = 0;
      const badExamples = [];
      for (const f of facet) {
        if (f.value === "0" || f.value === "") { zeroN += f.count; continue; }
        if (anafLib.isStructurallyValid(f.value)) validN += f.count;
        else if (badExamples.length < 5) badExamples.push({ value: f.value, count: f.count });
      }
      const invalidStructN = filled.cif - validN - zeroN;
      const problems = [];
      if (zeroN) problems.push({ type: "cif-zero", n: zeroN });
      if (invalidStructN > 0) problems.push({ type: "invalid-checksum", n: invalidStructN, examples: badExamples });
      report.cif = {
        filled: filled.cif, filledPct: pct(filled.cif, total),
        valid: validN, validPct: pct(validN, filled.cif || 0),
        problems,
      };
    }

    // location - tokenized/multiValued, "valid" reuses analytics' verified count
    {
      const ov = await analytics.overview();
      report.location = {
        filled: filled.location, filledPct: pct(filled.location, total),
        valid: ov.verified, validPct: pct(ov.verified, filled.location || 0),
        problems: [
          { type: "international", n: ov.international },
          { type: "junk", n: ov.junk },
        ],
      };
    }

    // tags - no format constraint defined
    report.tags = {
      filled: filled.tags, filledPct: pct(filled.tags, total),
      valid: filled.tags, validPct: pct(filled.tags, total),
      problems: [], note: "no validity rule defined beyond presence",
    };

    // workmode - string field, whitelist check
    {
      const facet = await solr.facet("workmode", "*:*", 200);
      let validN = 0; const bad = [];
      for (const f of facet) {
        if (WORKMODE_VALID.has(String(f.value).toLowerCase())) validN += f.count;
        else bad.push({ value: f.value, count: f.count });
      }
      report.workmode = {
        filled: filled.workmode, filledPct: pct(filled.workmode, total),
        valid: validN, validPct: pct(validN, filled.workmode || 0),
        problems: bad.length ? [{ type: "unrecognised-value", n: filled.workmode - validN, examples: bad.slice(0, 5) }] : [],
      };
    }

    // salary - tokenized, validity via the shared bucket scan
    {
      const sal = await getSalaryBuckets();
      report.salary = {
        filled: filled.salary, filledPct: pct(filled.salary, total),
        valid: sal.data.parseableCount, validPct: pct(sal.data.parseableCount, filled.salary || 0),
        problems: [],
      };
    }

    // date - pdate type: Solr rejects unparsable dates at write time
    report.date = {
      filled: filled.date, filledPct: pct(filled.date, total),
      valid: filled.date, validPct: pct(filled.date, total),
      problems: [], note: "Solr's pdate field type refuses malformed dates at index time",
    };

    // status - string field, no fixed whitelist (vocabulary may evolve) - report distinct values
    {
      const facet = await solr.facet("status", "*:*", 200);
      report.status = {
        filled: filled.status, filledPct: pct(filled.status, total),
        valid: filled.status, validPct: pct(filled.status, total),
        problems: [], distinctValues: facet.map((f) => ({ value: f.value, count: f.count })),
      };
    }

    return { total, fields: report };
  });
}

async function getFields() {
  const c = await buildFieldsReport();
  return { status: 200, body: { total: c.data.total, fields: c.data.fields, generatedAt: c.generatedAt, cacheAgeMs: c.cacheAgeMs } };
}

// =======================================================================
// GET /api/warnings
// =======================================================================
const ADULT_QUERY = 'title:(escort OR erotic OR "masaj erotic" OR "dama de companie" OR "dame de companie" OR onlyfans OR striptease OR strip OR "content adult")';

function getAdultTitles() {
  return cached("adultTitles", 5 * 60_000, async () => {
    const solr = job();
    const n = await solr.count(ADULT_QUERY);
    const examples = n > 0 ? await solr.sample(ADULT_QUERY, "url,title,company", 20) : [];
    return { n, examples };
  });
}

async function getWarnings() {
  const [w, adult] = await Promise.all([analytics.warnings(), getAdultTitles()]);
  return {
    status: 200,
    body: {
      weirdTitles: w.weirdTitles,
      shoutingTitles: w.shoutingTitles,
      duplicateTitles: w.duplicateTitles,
      missingSalary: w.missingSalary,
      missingCif: w.missingCif,
      missingTags: w.missingTags,
      adultOrEscortTitles: adult.data,
      _meta: { adultTitlesGeneratedAt: adult.generatedAt, adultTitlesCacheAgeMs: adult.cacheAgeMs },
    },
  };
}

// =======================================================================
// GET /api/locations  +  GET /api/locations/proposed
// (shared: one bounded, paged scan of the `location` field, classified
// with lib/locations.js exactly like doctor.js normalize's dry run)
// =======================================================================
async function buildLocationTally() {
  const solr = job();
  const idx = getLocIndex();
  const raw = new Map(); // raw location string -> doc count
  for await (const d of solr.scan("*:*", "location", 2000)) {
    const vals = Array.isArray(d.location) ? d.location : d.location ? [d.location] : [];
    for (const v of vals) {
      if (!v) continue;
      raw.set(v, (raw.get(v) || 0) + 1);
    }
  }
  const classified = [];
  for (const [value, count] of raw.entries()) {
    const c = locationsLib.classify(value, idx);
    classified.push({ raw: value, count, kind: c.kind, normalized: c.value !== undefined ? c.value : null, how: c.how });
  }
  return { classified, distinctCount: classified.length };
}
function getLocationTally() { return cached("locationTally", 5 * 60_000, buildLocationTally); }

async function getLocations() {
  const [ls, tally] = await Promise.all([analytics.locationStats(), getLocationTally()]);
  const bad = { foreign: [], junk: [], fake: [], unknown: [] };
  for (const item of tally.data.classified) {
    if (item.kind === "international") {
      bad.foreign.push({ value: item.raw, count: item.count, how: item.how });
    } else if (item.kind === "junk") {
      if (item.how === "empty") bad.unknown.push({ count: item.count, how: item.how });
      else if (/\d/.test(item.raw || "")) bad.fake.push({ value: item.raw, count: item.count, how: item.how });
      else bad.junk.push({ value: item.raw, count: item.count, how: item.how });
    }
  }
  for (const k of Object.keys(bad)) bad[k].sort((a, b) => b.count - a.count);
  return {
    status: 200,
    body: {
      verified: ls.verified, unverified: ls.unverified, international: ls.international, junk: ls.junk,
      topLocalities: ls.topLocalities,
      bad: {
        foreign: bad.foreign.slice(0, 30),
        junk: bad.junk.slice(0, 30),
        fake: bad.fake.slice(0, 30),
        unknown: bad.unknown.slice(0, 5),
      },
      note: "buckets classify every distinct raw location string in the index via lib/locations.classify(): foreign = recognised non-Romanian place, junk = not a place at all, fake = a junk value that contains digits (looks like a fabricated code/id), unknown = an empty location value.",
      _meta: { tallyGeneratedAt: tally.generatedAt, tallyCacheAgeMs: tally.cacheAgeMs, distinctLocationValues: tally.data.distinctCount },
    },
  };
}

async function getLocationsProposed() {
  const tally = await getLocationTally();
  const proposed = tally.data.classified
    .filter((item) => item.kind === "fixed" && item.normalized && item.normalized !== item.raw)
    .map((item) => ({ before: item.raw, after: item.normalized, rule: item.how, count: item.count }))
    .sort((a, b) => b.count - a.count);
  const totalJobsAffected = proposed.reduce((s, p) => s + p.count, 0);
  return {
    status: 200,
    body: {
      wouldRewrite: proposed.length,
      totalJobsAffected,
      proposed: proposed.slice(0, 300),
      note: "read-only preview - classifies every distinct location value with the same lib/locations.classify() logic doctor.js normalize uses, but writes nothing. POST /api/normalize (with confirm:true) to actually apply.",
      _meta: { tallyGeneratedAt: tally.generatedAt, tallyCacheAgeMs: tally.cacheAgeMs },
    },
  };
}

// =======================================================================
// GET /api/companies
// =======================================================================
async function buildCompaniesReport() {
  const solr = job();
  const facet = await solr.facet("company", "*:*", 5000);
  const top = facet.slice(0, 30);
  const flagged = [];
  for (const f of top) {
    const hasEntity = ENTITY_RE.test(f.value);
    let cifSample = null, cifValid = null;
    try {
      const docs = await solr.sample(phraseQuery("company", f.value) + " AND cif:*", "cif", 1);
      cifSample = docs[0] ? docs[0].cif : null;
    } catch { /* leave null */ }
    if (cifSample) cifValid = anafLib.isStructurallyValid(cifSample);
    const flags = [];
    if (hasEntity) flags.push("html-entities-in-name");
    if (!cifSample) flags.push("no-cif");
    else if (cifValid === false) flags.push("invalid-cif");
    if (flags.length) flagged.push({ company: f.value, count: f.count, cifSample, flags });
  }
  return { total: facet.length, top: top.map((f) => ({ company: f.value, count: f.count })), flagged };
}
function getCompaniesCached() { return cached("companies", 60_000, buildCompaniesReport); }

async function getCompanies() {
  const c = await getCompaniesCached();
  return { status: 200, body: { ...c.data, generatedAt: c.generatedAt, cacheAgeMs: c.cacheAgeMs } };
}

// =======================================================================
// GET /api/salary
// =======================================================================
async function getSalary() {
  const [stats, buckets] = await Promise.all([analytics.salaryStats(), getSalaryBuckets()]);
  return {
    status: 200,
    body: {
      ...stats,
      distribution: buckets.data.buckets,
      note: "avg/median/min/max/currency/samples come from lib/analytics.js's unit-aware parser (excludes hourly/daily rates and deposits). `distribution` is a simpler regex-only bucket pass across the same salary+title fields, cached separately, for charting only.",
      _meta: { bucketsGeneratedAt: buckets.generatedAt, bucketsCacheAgeMs: buckets.cacheAgeMs },
    },
  };
}

// =======================================================================
// GET /api/complete
// =======================================================================
async function buildComplete() {
  const solr = job();
  const total = await solr.count("*:*");
  const allFilledQuery = FIELD_NAMES.map((f) => f + ":*").join(" AND ");
  const complete = total ? await solr.count(allFilledQuery) : 0;
  const missingByField = await Promise.all(
    FIELD_NAMES.map(async (f) => ({ field: f, missing: await solr.count("-" + f + ":*") }))
  );
  missingByField.sort((a, b) => b.missing - a.missing);
  return { total, complete, completePct: pct(complete, total), incomplete: total - complete, missingByField };
}
function getCompleteCached() { return cached("complete", 60_000, buildComplete); }

async function getComplete() {
  const c = await getCompleteCached();
  return { status: 200, body: { ...c.data, generatedAt: c.generatedAt, cacheAgeMs: c.cacheAgeMs } };
}

// =======================================================================
// GET /api/links?limit=N
// =======================================================================
async function getLinks({ query }) {
  const limit = Math.min(Math.max(parseInt(query && query.limit, 10) || 50, 1), 200);
  const key = "links:" + limit;
  const c = await cached(key, 10 * 60_000, async () => {
    const solr = job();
    const docs = await solr.sample("url:*", "url,company", limit);
    const urls = [...new Set(docs.map((d) => d.url).filter(Boolean))];
    const { results, summary } = await linksLib.check(urls);
    return { requested: limit, checked: urls.length, summary, byDomain: summary.byHost, results };
  });
  return { status: 200, body: { ...c.data, generatedAt: c.generatedAt, cacheAgeMs: c.cacheAgeMs } };
}

// =======================================================================
// GET /api/occupations
// =======================================================================
async function buildOccupations() {
  const solr = job();
  const idx = getCorIndex();
  const titleCounts = new Map();
  for await (const d of solr.scan("*:*", "title", 2000)) {
    if (!d.title) continue;
    titleCounts.set(d.title, (titleCounts.get(d.title) || 0) + 1);
  }
  const codeCounts = new Map();
  const unmatched = [];
  const tally = { exact: 0, synonym: 0, fuzzy: 0, unmatched: 0 };
  for (const [title, count] of titleCounts.entries()) {
    const m = corLib.matchTitle(title, idx);
    if (!m) { tally.unmatched++; unmatched.push({ title, count }); continue; }
    if (m.how === "exact") tally.exact++;
    else if (m.how === "synonym") tally.synonym++;
    else tally.fuzzy++;
    const cur = codeCounts.get(m.code) || { code: m.code, name: m.name, count: 0 };
    cur.count += count;
    codeCounts.set(m.code, cur);
  }
  unmatched.sort((a, b) => b.count - a.count);
  const topOccupations = [...codeCounts.values()].sort((a, b) => b.count - a.count);
  const jobs = [...titleCounts.values()].reduce((s, n) => s + n, 0);
  const matchedJobs = topOccupations.reduce((s, x) => s + x.count, 0);
  return {
    jobs, distinctTitles: titleCounts.size,
    matchedJobs, unmatchedJobs: jobs - matchedJobs, matchedPct: pct(matchedJobs, jobs),
    tally, topOccupations: topOccupations.slice(0, 30), unmatchedTitles: unmatched.slice(0, 30),
  };
}
function getOccupationsCached() { return cached("occupations", 10 * 60_000, buildOccupations); }

async function getOccupations() {
  const c = await getOccupationsCached();
  return { status: 200, body: { ...c.data, generatedAt: c.generatedAt, cacheAgeMs: c.cacheAgeMs } };
}

// =======================================================================
// GET /api/tips - the differentiator: turn numbers into advice
// =======================================================================
async function buildTips() {
  return cached("tips", 60_000, async () => {
    const [ovR, fieldsR, warnR, locR, propR, compR, completeR, occR] = await Promise.all([
      getOverview(), getFields(), getWarnings(), getLocations(), getLocationsProposed(),
      getCompanies(), getComplete(), getOccupations(),
    ]);
    const ov = ovR.body, fields = fieldsR.body, warn = warnR.body, loc = locR.body,
      prop = propR.body, comp = compR.body, complete = completeR.body, occ = occR.body;
    const total = ov.jobs || 0;
    const tips = [];

    const salaryF = fields.fields.salary;
    if (salaryF && total > 0) {
      const missingPct = round(100 - salaryF.filledPct, 1);
      if (missingPct > 80) {
        tips.push({
          severity: missingPct > 95 ? "high" : "medium",
          title: `${missingPct}% of jobs have no salary information`,
          detail: `${total - salaryF.filled} of ${total} jobs carry no parseable salary. This is almost always because the scraper only captures the listing summary, not the full job-description page where pay is usually mentioned - salary cannot be recovered from the index alone.`,
          evidence: { missing: total - salaryF.filled, total, pct: missingPct },
          suggestedAction: "Extend the relevant scrapers to also pull the salary line from the full job description page, not just the listing card.",
        });
      }
    }

    const shoutingN = warn.shoutingTitles && warn.shoutingTitles.n;
    if (shoutingN > 0) {
      tips.push({
        severity: total && shoutingN > total * 0.2 ? "medium" : "low",
        title: `${shoutingN} job title${shoutingN === 1 ? "" : "s"} written in ALL CAPS`,
        detail: `${shoutingN} of ${total} titles are shouting (e.g. "URGENT ANGAJAM SOFERI"). This hurts search relevance ranking and looks unprofessional in the UI.`,
        evidence: { n: shoutingN, total },
        suggestedAction: "Add a title-casing normalization pass to the ingestion pipeline (Title Case or sentence case) before indexing.",
      });
    }

    if (warn.adultOrEscortTitles && warn.adultOrEscortTitles.n > 0) {
      tips.push({
        severity: "high",
        title: `${warn.adultOrEscortTitles.n} job title(s) look adult/escort-related`,
        detail: "Titles matched adult-industry keywords (escort, erotic, onlyfans, ...). Very likely policy violations for a mainstream job board.",
        evidence: { n: warn.adultOrEscortTitles.n, examples: warn.adultOrEscortTitles.examples.slice(0, 3) },
        suggestedAction: "Review and remove these listings; consider blocking the source domain if this recurs.",
      });
    }

    if (warn.duplicateTitles && warn.duplicateTitles.length) {
      tips.push({
        severity: "low",
        title: `${warn.duplicateTitles.length} title/company pairs posted more than once`,
        detail: `The same title+company combination appears multiple times (e.g. "${warn.duplicateTitles[0].title}" x${warn.duplicateTitles[0].count}). Likely the same job re-scraped or re-posted.`,
        evidence: { distinctDuplicatedPairs: warn.duplicateTitles.length, top: warn.duplicateTitles.slice(0, 5) },
        suggestedAction: "Deduplicate on (title, company, location) before indexing, or update the existing doc on re-scrape instead of inserting a new one.",
      });
    }

    const cifF = fields.fields.cif;
    if (cifF) {
      const zero = (cifF.problems || []).find((p) => p.type === "cif-zero");
      if (zero && zero.n > 0) {
        tips.push({
          severity: "medium",
          title: `${zero.n} jobs have cif=0`,
          detail: `${zero.n} of ${total} jobs carry cif=0, which can never link to a real company record - it's a placeholder value, not distinguishable from "we don't know".`,
          evidence: { n: zero.n, total },
          suggestedAction: "Have the scraper leave cif empty (not 0) when it can't determine the company, and backfill via lib/anaf.js verify() once a real CIF is known.",
        });
      }
      const badChecksum = (cifF.problems || []).find((p) => p.type === "invalid-checksum");
      if (badChecksum && badChecksum.n > 0) {
        tips.push({
          severity: "medium",
          title: `${badChecksum.n} CIFs fail the official checksum`,
          detail: "These CIF values aren't just unverified against ANAF - they are structurally impossible Romanian CUIs (fail the check-digit formula), meaning they were entered/scraped wrong.",
          evidence: { n: badChecksum.n, examples: badChecksum.examples },
          suggestedAction: "Re-scrape or manually correct these CIFs; lib/anaf.js's isStructurallyValid() rejects them before even calling ANAF.",
        });
      }
    }

    if (comp.flagged && comp.flagged.length) {
      const withEntities = comp.flagged.filter((f) => f.flags.includes("html-entities-in-name"));
      if (withEntities.length) {
        tips.push({
          severity: "low",
          title: `${withEntities.length} top compan${withEntities.length === 1 ? "y has" : "ies have"} raw HTML entities in the name`,
          detail: `e.g. "${withEntities[0].company}" - the scraper is storing HTML-escaped text (&amp;, &quot;, ...) instead of decoding it.`,
          evidence: { examples: withEntities.slice(0, 5) },
          suggestedAction: "Decode HTML entities in the scraper before indexing the company field (see decodeEntities() in lib/analytics.js for the exact rule set).",
        });
      }
      const noCif = comp.flagged.filter((f) => f.flags.includes("no-cif"));
      if (noCif.length) {
        tips.push({
          severity: "medium",
          title: `${noCif.length} top compan${noCif.length === 1 ? "y has" : "ies have"} no CIF at all`,
          detail: `e.g. "${noCif[0].company}" (${noCif[0].count} jobs) - these companies can never be cross-checked against ANAF or linked to the company core.`,
          evidence: { examples: noCif.slice(0, 5) },
          suggestedAction: "Prioritize fixing the scraper for these sources - they are high-volume companies missing a basic identifier.",
        });
      }
    }

    if (loc.junk > 0) {
      tips.push({
        severity: total && loc.junk > total * 0.1 ? "medium" : "low",
        title: `${loc.junk} jobs have a junk location (not a real place)`,
        detail: `${loc.junk} of ${total} jobs have a location value lib/locations.js could not recognise as any real place, foreign or Romanian.`,
        evidence: { n: loc.junk, total, examples: loc.bad.junk.slice(0, 5) },
        suggestedAction: "Run POST /api/normalize (confirm:true) to flag them, then review doctor.js purge-junk for outright deletion candidates.",
      });
    }
    if (prop.wouldRewrite > 0) {
      tips.push({
        severity: "low",
        title: `${prop.wouldRewrite} location values would be auto-corrected by normalize`,
        detail: `Running the normalizer would rewrite ${prop.totalJobsAffected} jobs' locations to their canonical SIRUTA spelling (e.g. "${prop.proposed[0].before}" -> "${prop.proposed[0].after}").`,
        evidence: { wouldRewrite: prop.wouldRewrite, totalJobsAffected: prop.totalJobsAffected, sample: prop.proposed.slice(0, 5) },
        suggestedAction: "Review GET /api/locations/proposed, then run POST /api/normalize with confirm:true when ready.",
      });
    }

    if (complete.missingByField && complete.missingByField.length && complete.missingByField[0].missing > 0) {
      const worst = complete.missingByField[0];
      tips.push({
        severity: "info",
        title: `Only ${complete.completePct}% of jobs have every field filled`,
        detail: `${complete.incomplete} of ${complete.total} jobs are missing at least one field. "${worst.field}" is missing most often (${worst.missing} jobs).`,
        evidence: { completePct: complete.completePct, missingByField: complete.missingByField },
        suggestedAction: `Prioritize scraper fixes for "${worst.field}" - it accounts for the largest gap.`,
      });
    }

    if (occ.jobs > 0 && occ.matchedPct < 70) {
      tips.push({
        severity: "low",
        title: `${round(100 - occ.matchedPct, 1)}% of job titles don't map to an official COR occupation`,
        detail: `${occ.unmatchedJobs} of ${occ.jobs} jobs' titles could not be confidently matched to a COR code. Expected for free-text titles, but it limits occupation-based filtering.`,
        evidence: { unmatchedJobs: occ.unmatchedJobs, jobs: occ.jobs, sample: occ.unmatchedTitles.slice(0, 5) },
        suggestedAction: "Extend lib/cor.js's SYNONYM_GROUPS with the most frequent unmatched titles.",
      });
    }

    // Dead-link tips only from a link check already run this session
    // (never triggers one - that hits other people's servers).
    let sawLinkCheck = false;
    for (const [k, v] of _cache.entries()) {
      if (!k.startsWith("links:")) continue;
      sawLinkCheck = true;
      for (const [host, stats] of Object.entries(v.data.byDomain || {})) {
        if (stats.dead >= 3) {
          tips.push({
            severity: "medium",
            title: `${stats.dead} dead links on ${host}`,
            detail: `${stats.dead} sampled job URLs on ${host} return 404/410. That scraper may be pointing at stale or removed listings.`,
            evidence: { host, dead: stats.dead, ok: stats.ok },
            suggestedAction: `Check the ${host} scraper - it may need to detect and skip removed postings.`,
          });
        }
      }
      break;
    }
    if (!sawLinkCheck) {
      tips.push({
        severity: "info",
        title: "Link health has not been checked yet this session",
        detail: "GET /api/links?limit=50 samples job URLs and checks whether they still resolve, distinguishing dead (404) from bot-blocked (403).",
        evidence: {},
        suggestedAction: "Call GET /api/links to populate this.",
      });
    }

    const order = { high: 0, medium: 1, low: 2, info: 3 };
    tips.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
    return { count: tips.length, tips };
  });
}

async function getTips() {
  const c = await buildTips();
  return { status: 200, body: { ...c.data, generatedAt: c.generatedAt, cacheAgeMs: c.cacheAgeMs } };
}

// =======================================================================
// POST /api/chat
// =======================================================================
/**
 * POST /api/chat/stream - Server-Sent Events.
 * Writes directly to the response, so this handler owns the socket and must
 * return { __raw: true } to tell the router not to send anything after it.
 */
async function postChatStream({ body, res }) {
  const text = body && body.text;
  if (!text || typeof text !== "string") {
    return { status: 400, body: { error: "lipseste campul 'text'" } };
  }
  const history = Array.isArray(body.messages) ? body.messages : [];

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (obj) => { try { res.write("data: " + JSON.stringify(obj) + String.fromCharCode(10, 10)); } catch { /* client gone */ } };

  try {
    const { askStream } = require(path.join(__dirname, "assistant.js"));
    const out = await askStream(history, text, (ev) => send(ev));
    send({ type: "done", answer: out.answer, toolsUsed: out.toolsUsed });
  } catch (e) {
    send({ type: "error", error: String(e.message).slice(0, 300) });
  }
  res.end();
  return { __raw: true };
}

async function postChat({ body }) {
  if (!body || typeof body !== "object") return { status: 400, body: { error: "expected a JSON body" } };
  const { messages, text } = body;
  if (!text || typeof text !== "string") {
    return { status: 400, body: { error: "expected { messages: [...], text: '...' } - 'text' is required" } };
  }
  const history = Array.isArray(messages) ? messages : [];
  try {
    const { answer, toolsUsed } = await ask(history, text, () => {});
    return { status: 200, body: { answer, toolsUsed } };
  } catch (e) {
    return { status: 502, body: { error: "assistant failed: " + e.message } };
  }
}

// =======================================================================
// POST /api/normalize - the only write endpoint. Refuses without confirm:true.
// =======================================================================
async function postNormalize({ body }) {
  if (!body || body.confirm !== true) {
    return { status: 400, body: { error: 'refusing to write: POST body must include { "confirm": true }' } };
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [path.join(ROOT, "doctor.js"), "normalize", "--apply"], { cwd: ROOT });
    } catch (e) {
      resolve({ status: 500, body: { error: "failed to spawn doctor.js: " + e.message } });
      return;
    }
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => resolve({ status: 500, body: { error: "failed to spawn doctor.js: " + e.message } }));
    child.on("close", (code) => {
      let lastRun = null;
      try { lastRun = JSON.parse(fs.readFileSync(path.join(ROOT, "last_run.json"), "utf8")); } catch { /* no summary available */ }
      // invalidate what this write just changed; analytics.js's own 10-min
      // cache will pick up fresh numbers on its own schedule.
      _cache.delete("locationTally");
      for (const k of [..._cache.keys()]) if (k.startsWith("links:")) _cache.delete(k);
      resolve({
        status: code === 0 ? 200 : 500,
        body: {
          ok: code === 0,
          exitCode: code,
          summary: lastRun ? { when: lastRun.when, applied: lastRun.applied, total: lastRun.total, skipped: lastRun.skipped, stats: lastRun.stats } : null,
          log: (out + err).split("\n").slice(-80).join("\n"),
        },
      });
    });
  });
}

module.exports = {
  getHealth, getOverview, getFields, getWarnings, getLocations, getLocationsProposed,
  getCompanies, getSalary, getComplete, getLinks, getOccupations, getTips,
  postChat, postChatStream, postNormalize,
};
