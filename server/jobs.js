"use strict";
/**
 * server/jobs.js - the drill-down API.
 *
 * Every number the UI shows comes from /api/checks, and every number is
 * resolvable to its rows through /api/jobs?issue=<id>. Same registry, same
 * query, so a count can never disagree with the evidence behind it.
 *
 * All rows are REAL documents read out of Solr. Nothing here invents data.
 */
const path = require("path");
const { Solr } = require(path.join(__dirname, "..", "lib", "solr.js"));
const rules = require(path.join(__dirname, "..", "lib", "rules.js"));
const judge = require(path.join(__dirname, "..", "lib", "judge.js"));

const job = () => new Solr({ core: "job" });

/** escape a user term for a Solr query; `title` and `company` are analysed
 *  fields, so a quoted phrase is the predictable way to match */
const solrTerm = (t) => '"' + String(t).replace(/[^\p{L}\p{N}\s.&-]/gu, " ").trim() + '"';

// only fields the peviitor_core schema defines - the derived location data is
// read from cache/locations.json and merged in by shape()
const FL = "url,title,company,cif,location,workmode,salary,date,status";

const LOC_CACHE = path.join(__dirname, "..", "cache", "locations.json");
let locCache = null, locCacheAt = 0;
function derivedLocations() {
  try {
    const st = require("fs").statSync(LOC_CACHE);
    if (!locCache || st.mtimeMs !== locCacheAt) {
      locCache = JSON.parse(require("fs").readFileSync(LOC_CACHE, "utf8")).derived || {};
      locCacheAt = st.mtimeMs;
    }
  } catch { locCache = locCache || {}; }
  return locCache;
}

let materializing = null;      // in-flight promise, so two clicks share one scan
let lastProgress = 0;

/** GET /api/checks - every rule with its count, plus the health score. */
async function getChecks() {
  const { total, at, rules: list } = await rules.counts();
  const s = rules.score(list);
  const groups = {};
  for (const r of list) (groups[r.group] = groups[r.group] || []).push(r);
  return {
    status: 200,
    body: {
      total,
      scannedAt: at,
      score: s.score,
      measured: s.measured,
      totalRules: s.of,
      materializing: !!materializing,
      progress: lastProgress,
      groups: Object.entries(groups).map(([name, items]) => ({ name, items })),
      rules: list,
    },
  };
}

/**
 * Free-text filter over a candidate set.
 *
 * It filters the WHOLE set, not the page you happen to be looking at -
 * filtering 50 visible rows out of 37.000 would be a lie. For a rule whose
 * urls are materialized we fetch the matching documents in batches and keep
 * the ones whose title or company contains the term.
 */
function matchesTerm(doc, term) {
  if (!term) return true;
  const t = term.toLowerCase();
  const fold = (x) => String(x == null ? "" : x)
    .replace(/[ăâîșț]/g, (c) => ({ "ă": "a", "â": "a", "î": "i", "ș": "s", "ț": "t" }[c]))
    .toLowerCase();
  const ft = fold(term);
  return (
    String(doc.title || "").toLowerCase().includes(t) || fold(doc.title).includes(ft) ||
    String(doc.company || "").toLowerCase().includes(t) || fold(doc.company).includes(ft)
  );
}

/** page a materialized url list, applying the search term across all of it */
async function pageUrls(solr, urls, offset, limit, term) {
  if (!term) {
    const slice = urls.slice(offset, offset + limit);
    const rows = slice.length ? await fetchByUrls(solr, slice) : [];
    return { total: urls.length, rows };
  }
  const kept = [];
  const BATCH = 200;
  const CAP = 4000;                       // enough to page through; keeps it fast
  for (let i = 0; i < urls.length && kept.length < offset + limit + CAP; i += BATCH) {
    const docs = await fetchByUrls(solr, urls.slice(i, i + BATCH));
    for (const d of docs) if (matchesTerm(d, term)) kept.push(d);
  }
  return { total: kept.length, rows: kept.slice(offset, offset + limit) };
}

/**
 * GET /api/jobs?issue=<rule-id>&offset=0&limit=50
 * Also accepts &loc=<canonical locality> (resolved from the sidecar) and
 * &company=<exact company> so a chart bar can drill into its own slice.
 * so a chart bar can drill into its own slice.
 */
async function getJobs({ query }) {
  const q = query || {};
  const offset = Math.max(0, parseInt(q.offset, 10) || 0);
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
  const term = String(q.q || "").trim();
  const solr = job();

  // --- a chart slice ------------------------------------------------------
  // company is a `string` field, so Solr can match it exactly. Locality is NOT:
  // `location` is text_general, so an exact query on it matches tokens. The
  // canonical locality therefore resolves through the sidecar instead.
  if (q.company) {
    let sq = `company:"${String(q.company).replace(/"/g, '\\"')}"`;
    if (term) sq += ` AND (title:${solrTerm(term)} OR company:${solrTerm(term)})`;
    const total = await solr.count(sq);
    const docs = await solrPage(solr, sq, offset, limit);
    return { status: 200, body: { issue: null, filter: { field: "company", value: q.company }, total, offset, limit, rows: docs } };
  }
  if (q.loc) {
    const derived = derivedLocations();
    const want = String(q.loc);
    const urls = [];
    for (const url in derived) {
      const e = derived[url];
      if (e && e.canonical && e.canonical.indexOf(want) !== -1) urls.push(url);
    }
    const paged = await pageUrls(solr, urls, offset, limit, term);
    return { status: 200, body: { issue: null, filter: { field: "location", value: want }, total: paged.total, offset, limit, rows: paged.rows } };
  }

  const rule = rules.byId.get(q.issue);
  if (!rule) return { status: 404, body: { error: "regula necunoscuta: " + q.issue } };

  // --- tier "solr": page straight out of the index ------------------------
  if (rule.tier === "solr") {
    let rq = rule.q;
    if (term) rq = `(${rq}) AND (title:${solrTerm(term)} OR company:${solrTerm(term)})`;
    const total = await solr.count(rq);
    const docs = await solrPage(solr, rq, offset, limit);
    return { status: 200, body: { issue: rule.id, label: rule.label, total, offset, limit, rows: docs } };
  }

  // --- tier "judge": the confirmed subset of the source rule's candidates --
  if (rule.tier === "judge") {
    const sum = await judge.summary(rule.judge);
    if (!sum || sum.candidates == null) {
      return { status: 409, body: { error: "nemasurat", issue: rule.id, hint: "Ruleaza intai analiza deterministica, apoi verificarea AI." } };
    }
    const urls = sum.confirmedUrls;
    const paged = await pageUrls(solr, urls, offset, limit, term);
    const rows = paged.rows;
    attachVerdicts(rows, rule.judge);
    return {
      status: 200,
      body: {
        issue: rule.id, label: rule.label, total: paged.total, offset, limit, rows,
        judge: { id: rule.judge, candidates: sum.candidates, judged: sum.judged, tally: sum.tally, model: sum.model },
      },
    };
  }

  // --- tier "scan": slice the materialized url list, then fetch those docs -
  const cache = rules.readCache();
  if (!cache || !cache.hits || !cache.hits[rule.id]) {
    return {
      status: 409,
      body: { error: "nemasurat", issue: rule.id, hint: "Ruleaza analiza (POST /api/materialize) ca sa vezi randurile." },
    };
  }
  const urls = cache.hits[rule.id];
  const paged = await pageUrls(solr, urls, offset, limit, term);
  const rows = paged.rows;
  // a candidate rule that has a judge shows the verdict next to each row
  if (rule.judgedBy) attachVerdicts(rows, rule.judgedBy);
  const body = { issue: rule.id, label: rule.label, total: paged.total, offset, limit, rows };
  if (rule.judgedBy) {
    const sum = await judge.summary(rule.judgedBy);
    if (sum) body.judge = { id: rule.judgedBy, candidates: sum.candidates, judged: sum.judged, tally: sum.tally, model: sum.model, verdicts: sum.verdicts };
  }
  return { status: 200, body };
}

/** decorate rows in place with the cached AI/human verdict, if there is one */
function attachVerdicts(rows, judgeId) {
  const map = judge.verdictMap(judgeId, rows.map((r) => ({ url: r.url, title: r.title, company: r.company })));
  for (const r of rows) {
    const v = map.get(r.url);
    r.verdict = v ? v.verdict : null;
    r.verdictReason = v ? v.reason : null;
    r.verdictSource = v ? v.source : null;   // "ai" or "om"
  }
}

async function solrPage(solr, q, offset, limit) {
  const j = await solr._get(
    `/select?q=${encodeURIComponent(q)}&fl=${encodeURIComponent(FL)}&rows=${limit}&start=${offset}&wt=json`
  );
  return j.response.docs.map(shape);
}

/**
 * Fetch an exact set of documents by uniqueKey, preserving the given order.
 *
 * Job urls are long, so a single `url:("a" OR "b" OR ...)` query blows past
 * what a GET can carry - 400 of them is ~44.000 characters and the request
 * simply fails. Chunk it.
 */
async function fetchByUrls(solr, urls) {
  const CHUNK = 40;
  const byUrl = new Map();
  for (let i = 0; i < urls.length; i += CHUNK) {
    const part = urls.slice(i, i + CHUNK);
    const clause = part.map((u) => `"${String(u).replace(/"/g, '\\"')}"`).join(" OR ");
    const j = await solr._get(
      `/select?q=${encodeURIComponent("url:(" + clause + ")")}&fl=${encodeURIComponent(FL)}&rows=${part.length}&wt=json`
    );
    for (const d of j.response.docs) byUrl.set(d.url, d);
  }
  return urls.map((u) => byUrl.get(u)).filter(Boolean).map(shape);
}

/** one row shape for the whole UI, so the table never guesses key names */
function shape(d) {
  const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const e = derivedLocations()[d.url] || null;
  return {
    url: d.url || "",
    title: d.title || "",
    company: d.company || "",
    cif: d.cif || "",
    location: arr(d.location),
    locationCanonical: e ? e.canonical : [],
    locKind: e ? e.kind : null,
    locHow: e ? e.how : null,
    workmode: d.workmode || null,
    salary: d.salary || null,
    date: d.date || null,
    status: d.status || null,
  };
}

/** POST /api/materialize - one scan evaluates every JS rule. */
async function postMaterialize({ body }) {
  if (!body || body.confirm !== true) {
    return { status: 400, body: { error: "trimite { confirm: true } ca sa pornesti analiza" } };
  }
  if (materializing) return { status: 200, body: { started: false, alreadyRunning: true } };
  lastProgress = 0;
  materializing = rules
    .materialize({ onProgress: (n) => { lastProgress = n; } })
    .then((r) => { materializing = null; return r; })
    .catch((e) => { materializing = null; throw e; });
  return { status: 202, body: { started: true } };
}

/** GET /api/materialize/status */
async function getMaterializeStatus() {
  const cache = rules.readCache();
  return {
    status: 200,
    body: {
      running: !!materializing,
      progress: lastProgress,
      at: cache ? cache.at : null,
      seconds: cache ? cache.seconds : null,
      scanned: cache ? cache.scanned : null,
      counts: cache ? cache.counts : null,
    },
  };
}

/**
 * GET /api/top?field=location|company|workmode|status&limit=20
 * `location` is counted from the sidecar (canonical values); the rest are exact
 * Solr facets on `string` fields.
 * Exact value facets. Only string fields are allowed here on purpose: faceting
 * `location` (text_general) returns tokens like "cluj"/"napoca" instead of
 * "Cluj-Napoca", which is exactly the bug this field was added to fix.
 */
const TOP_FIELDS = new Set(["location", "loc_kind", "company", "workmode", "status"]);
async function getTop({ query }) {
  const field = (query && query.field) || "company";
  if (!TOP_FIELDS.has(field)) return { status: 400, body: { error: "camp nepermis: " + field } };
  const limit = Math.min(Math.max(parseInt(query && query.limit, 10) || 20, 1), 100);
  if (field === "loc_kind") {
    const derived = derivedLocations();
    const tally = new Map();
    for (const url in derived) {
      const k = derived[url] && derived[url].kind;
      if (k) tally.set(k, (tally.get(k) || 0) + 1);
    }
    const items = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
    return { status: 200, body: { field, items, source: "cache/locations.json" } };
  }
  if (field === "location") {
    const derived = derivedLocations();
    const tally = new Map();
    for (const url in derived) {
      const e = derived[url];
      for (const v of (e && e.canonical) || []) tally.set(v, (tally.get(v) || 0) + 1);
    }
    const items = [...tally.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, limit)
      .map(([value, count]) => ({ value, count }));
    return { status: 200, body: { field, items, source: "cache/locations.json" } };
  }
  const solr = job();
  const rows = await solr.facet(field, "*:*", limit);
  return { status: 200, body: { field, items: rows.filter((r) => r.count > 0) } };
}

// =======================================================================
// the "judge" tier - AI adjudication of a deterministic candidate set
// =======================================================================

let judging = null;                 // in-flight run, so two clicks share one
let judgeProgress = { done: 0, of: 0, id: null };
let lastJudgeRun = null;

/**
 * POST /api/judge  { judge: "title_adult", confirm: true, force?: bool }
 * Runs the model over the candidates that do not already have a verdict.
 * Refuses without confirm:true - this is the only endpoint that spends money.
 */
async function postJudge({ body }) {
  const b = body || {};
  if (b.confirm !== true) return { status: 400, body: { error: "trimite { confirm: true } ca sa pornesti verificarea AI" } };
  const id = String(b.judge || "");
  if (!judge.SPECS[id]) return { status: 404, body: { error: "judecator necunoscut: " + id, disponibili: Object.keys(judge.SPECS) } };
  if (judging) return { status: 200, body: { started: false, alreadyRunning: true, progress: judgeProgress } };

  judgeProgress = { done: 0, of: 0, id };
  judging = judge
    .run(id, { force: b.force === true, onProgress: (done, of) => { judgeProgress = { done, of, id }; } })
    .then((r) => { judging = null; lastJudgeRun = r; return r; })
    .catch((e) => { judging = null; lastJudgeRun = { ok: false, error: e.message }; throw e; });
  return { status: 202, body: { started: true, judge: id } };
}

/** GET /api/judge/status?judge=title_adult */
async function getJudgeStatus({ query }) {
  const id = String((query && query.judge) || "title_adult");
  if (!judge.SPECS[id]) return { status: 404, body: { error: "judecator necunoscut: " + id } };
  const sum = await judge.summary(id);
  return {
    status: 200,
    body: { running: !!judging, progress: judgeProgress, lastRun: lastJudgeRun, summary: sum },
  };
}

/**
 * POST /api/judge/override { judge, url, verdict, reason?, by? }
 * A person correcting the model. Always wins, never overwritten by a re-run.
 * Send verdict:null to drop the override and fall back to the model.
 */
async function postJudgeOverride({ body }) {
  const b = body || {};
  const id = String(b.judge || "");
  if (!judge.SPECS[id]) return { status: 404, body: { error: "judecator necunoscut: " + id } };
  if (!b.url) return { status: 400, body: { error: "lipseste url" } };
  try {
    if (b.verdict === null) {
      const had = judge.clearOverride(id, String(b.url));
      return { status: 200, body: { cleared: had } };
    }
    const saved = judge.override(id, String(b.url), b.verdict, b.reason, b.by);
    return { status: 200, body: { ok: true, override: saved } };
  } catch (e) {
    return { status: 400, body: { error: e.message } };
  }
}

module.exports = {
  getChecks, getJobs, getTop, postMaterialize, getMaterializeStatus,
  postJudge, getJudgeStatus, postJudgeOverride,
};
