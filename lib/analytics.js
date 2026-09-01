"use strict";
/**
 * Analytics layer for the peviitor-doctor terminal dashboard.
 *
 * READ ONLY: only Solr.count/.sample/.facet/.scan are used. Nothing here
 * ever calls .update()/.deleteByQuery()/.commit().
 *
 * Two-tier cache, both under cache/:
 *
 *  - cache/aggregate.json (BASE_TTL_MS): one full Solr scan + a few facet/
 *    count calls. Everything except category classification lives here:
 *    overview, locationStats, warnings, salaryStats, companyStats, and a
 *    fast rules-only category baseline. Cold build is a few seconds; a
 *    single in-flight promise makes concurrent callers share the same
 *    build instead of stacking up duplicate scans.
 *
 *  - cache/category_assignments.json (CATEGORY_TTL_MS): the embeddings
 *    classification pass. This is the slow part (CPU inference over every
 *    distinct title not already caught by keyword rules) - on a cold
 *    vector cache it can take minutes over ~19k titles. It NEVER runs
 *    inline inside a request. categories() always answers immediately:
 *    if a (possibly slightly stale) embeddings result exists on disk, it
 *    is served straight away while a refresh is kicked off in the
 *    background if it's gone stale; if none exists yet, the fast
 *    rules-only classification is returned immediately (method:"rules")
 *    while the embeddings pass warms up in the background for next time.
 */

const fs = require("fs");
const path = require("path");
const { Solr } = require("./solr");
const embeddings = require("./embeddings");

const BASE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CATEGORY_TTL_MS = 10 * 60 * 1000; // 10 minutes (cheap to refresh once vectors are cached)
const CACHE_DIR = path.join(__dirname, "..", "cache");
const AGGREGATE_FILE = path.join(CACHE_DIR, "aggregate.json");
const CATEGORY_FILE = path.join(CACHE_DIR, "category_assignments.json");

const CATEGORY_TAXONOMY = JSON.parse(fs.readFileSync(path.join(__dirname, "categories.json"), "utf8"));
const FALLBACK_CATEGORY = CATEGORY_TAXONOMY.fallback;

// ---------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------

function stripDiacritics(s) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ț/gi, "t")
    .replace(/ş/gi, "s");
}

function normalizeForMatch(s) {
  return stripDiacritics(String(s).toLowerCase());
}

// Upstream scraper leaves raw HTML entities in company/title text (e.g.
// `&quot;AȘA, ȘI...?&quot;`, `IONUT&amp;MADA S.R.L.`). Decode for display
// only - this never writes anything back to Solr.
function decodeEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(n, d = 0) {
  if (n === null || n === undefined) return n;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function isFresh(generatedAt, ttlMs) {
  if (!generatedAt) return false;
  return Date.now() - new Date(generatedAt).getTime() < ttlMs;
}

// Precompute normalized keyword lists once.
const RULE_CATEGORIES = CATEGORY_TAXONOMY.categories.map((c) => ({
  name: c.name,
  keywords: c.keywords.map(normalizeForMatch),
  seeds: c.seeds,
}));

function classifyByRules(title) {
  const norm = normalizeForMatch(title);
  for (const cat of RULE_CATEGORIES) {
    for (const kw of cat.keywords) {
      if (norm.includes(kw)) return cat.name;
    }
  }
  return null;
}

function buildCategoryItems(distinctTitles, titleCounts, assignment) {
  const categoryCounts = new Map();
  const categoryExamples = new Map();
  for (const title of distinctTitles) {
    const cat = assignment.get(title) || FALLBACK_CATEGORY;
    const info = titleCounts.get(title);
    categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + info.count);
    if (!categoryExamples.has(cat)) categoryExamples.set(cat, []);
    const exArr = categoryExamples.get(cat);
    if (exArr.length < 5) exArr.push(title);
  }
  return [...categoryCounts.entries()]
    .map(([category, count]) => ({ category, count, examples: categoryExamples.get(category) || [] }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------
// salary parsing (see report: only 101 docs have `salary` filled, and a
// currency-aware title regex finds ~800/87749 title mentions; most jobs
// genuinely carry no salary information at all)
// ---------------------------------------------------------------------

const CURRENCY_RE = /(\d[\d.,]{1,6})\s*(?:[-–]\s*(\d[\d.,]{1,6})\s*)?(RON|lei|EUR|EURO|€|\$|USD)\b/i;

function normalizeCurrencyCode(raw) {
  const u = raw.toUpperCase();
  if (u === "LEI" || u === "RON") return "RON";
  if (u === "EUR" || u === "EURO" || u === "€") return "EUR";
  if (u === "$" || u === "USD") return "USD";
  return u;
}

// Real title text mixes incompatible pay units in the same free-text field:
// "45 lei/oră" (hourly), "70 Euro/zi" (daily) and "6500 RON" (monthly) all
// match the currency regex, but averaging them together would be dishonest
// (an hourly babysitting rate of 15-50 lei is not comparable to a monthly
// salary of 3000-7000 RON). Detect a rate suffix in the ~20 chars after the
// match and tag the unit so callers can keep monthly figures separate.
const HOUR_UNIT_RE = /or[ăa]|\/\s*h\b|hour/i;
const DAY_UNIT_RE = /\bzi\b|\/\s*zi|\bday\b/i;
// "499 Ron Garantie" / "500 ron ... masinii" - a car-rental deposit, not pay.
const DEPOSIT_RE = /garant/i;

function parseMoney(str) {
  const m = CURRENCY_RE.exec(str);
  if (!m) return null;
  const min = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
  const max = m[2] ? parseFloat(m[2].replace(/\./g, "").replace(",", ".")) : min;
  const currency = normalizeCurrencyCode(m[3]);
  if (!isFinite(min) || min <= 0) return null;

  const matchEnd = m.index + m[0].length;
  const before = str.slice(Math.max(0, m.index - 20), m.index);
  const after = str.slice(matchEnd, matchEnd + 20);
  if (DEPOSIT_RE.test(before) || DEPOSIT_RE.test(after)) return null;

  let unit = "month"; // default: lump-sum / monthly figure (the common case)
  if (HOUR_UNIT_RE.test(after)) unit = "hour";
  else if (DAY_UNIT_RE.test(after)) unit = "day";

  return { min, max: isFinite(max) ? max : min, avg: (min + (isFinite(max) ? max : min)) / 2, currency, unit, raw: str };
}

// ---------------------------------------------------------------------
// weird-title detection (Task D)
// ---------------------------------------------------------------------

function weirdTitleReasons(title) {
  const reasons = [];
  const t = String(title || "").trim();
  if (t.length < 4) reasons.push("too-short");
  if (t.length > 120) reasons.push("too-long");

  const letters = t.replace(/[^A-Za-zĂÂÎȘȚăâîșțĂĀ-ſ]/g, "");
  if (letters.length >= 4 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
    reasons.push("shouting");
  }

  const punctRun = /[!?.]{3,}/.test(t);
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/u.test(t);
  const nonWord = t.replace(/[A-Za-z0-9ĂÂÎȘȚăâîșț\s]/g, "");
  const punctRatio = t.length ? nonWord.length / t.length : 0;
  if (punctRun || emoji || punctRatio > 0.25) reasons.push("punctuation-heavy");

  return reasons;
}

// ---------------------------------------------------------------------
// base aggregate: one full scan + a few facet/count calls. NO embeddings.
// This is the only thing overview()/locationStats()/warnings()/
// salaryStats()/companyStats() and the rules fallback for categories()
// depend on, so none of them can ever be blocked by the slow embeddings
// pass.
// ---------------------------------------------------------------------

let _baseMemCache = null; // { generatedAt, data }
let _baseBuildPromise = null;

function readJsonSafe(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // corrupt cache - ignore
  }
  return null;
}

function writeJsonSafe(file, obj) {
  ensureCacheDir();
  try {
    fs.writeFileSync(file, JSON.stringify(obj));
  } catch {
    // best-effort disk cache; in-memory cache still works
  }
}

async function buildBaseAggregate() {
  const solr = new Solr();
  const t0 = Date.now();

  // facet.limit must be a large *positive* number, not -1: Solr's default
  // facet.sort is "count" only when facet.limit > 0, otherwise it silently
  // falls back to alphabetical ("index") order, which is what produced the
  // wrong companyStats() output. 200000 comfortably covers the ~11k
  // distinct companies actually referenced by job docs.
  const [jobs, verified, unverified, international, junk, cifMissing, tagsMissing, companyFacet] =
    await Promise.all([
      solr.count("*:*"),
      solr.count("verified:true"),
      solr.count("verified:false"),
      solr.count("international:true"),
      solr.count("junk:true"),
      solr.count("-cif:*"),
      solr.count("-tags:*"),
      solr.facet("company", "*:*", 200000),
    ]);

  let companies = null;
  try {
    const companySolr = new Solr({ core: "company" });
    companies = await companySolr.count("*:*");
  } catch {
    companies = null; // company core unavailable - report null rather than fake it
  }

  const localityCounts = new Map();
  const titleCounts = new Map(); // decoded title -> {count, company}
  const titleCompanyCounts = new Map(); // "title company" -> count
  const weirdExamples = [];
  const weirdCounts = { "too-short": 0, "too-long": 0, shouting: 0, "punctuation-heavy": 0 };

  let salaryFieldDocs = 0;
  let titleMoneyDocs = 0;
  const ronMonthlyAmounts = []; // only unit:"month" RON figures - see parseMoney
  let hourlyOrDailyCount = 0;
  const currencyCounts = {};
  const salarySamples = [];
  let genuineSalaryDocs = 0;

  for await (const d of solr.scan("*:*", "title,company,cif,location,tags,salary", 2000)) {
    const title = decodeEntities((d.title || "").toString().trim());
    const company = decodeEntities((d.company || "").toString().trim());

    if (title) {
      const cur = titleCounts.get(title);
      if (cur) cur.count++;
      else titleCounts.set(title, { count: 1, company });

      const key = title + " " + company;
      titleCompanyCounts.set(key, (titleCompanyCounts.get(key) || 0) + 1);

      for (const reason of weirdTitleReasons(title)) {
        weirdCounts[reason]++;
        if (weirdExamples.length < 200) weirdExamples.push({ title, reason, company });
      }
    }

    if (Array.isArray(d.location)) {
      for (const loc of new Set(d.location)) {
        if (!loc) continue;
        localityCounts.set(loc, (localityCounts.get(loc) || 0) + 1);
      }
    }

    let docHasSalary = false;
    if (Array.isArray(d.salary) && d.salary.length) {
      salaryFieldDocs++;
      for (const raw of d.salary) {
        const parsed = parseMoney(String(raw));
        if (parsed) {
          docHasSalary = true;
          currencyCounts[parsed.currency] = (currencyCounts[parsed.currency] || 0) + 1;
          if (parsed.currency === "RON" && parsed.unit === "month") ronMonthlyAmounts.push(parsed.avg);
          else if (parsed.unit !== "month") hourlyOrDailyCount++;
          if (salarySamples.length < 10) salarySamples.push(raw);
        }
      }
    }
    if (title) {
      const m = parseMoney(title);
      if (m) {
        titleMoneyDocs++;
        docHasSalary = true;
        currencyCounts[m.currency] = (currencyCounts[m.currency] || 0) + 1;
        if (m.currency === "RON" && m.unit === "month") ronMonthlyAmounts.push(m.avg);
        else if (m.unit !== "month") hourlyOrDailyCount++;
        if (salarySamples.length < 10) salarySamples.push(title);
      }
    }
    if (docHasSalary) genuineSalaryDocs++;
  }

  // duplicate titles (same title, same company, posted more than once)
  const duplicateTitles = [];
  for (const [key, count] of titleCompanyCounts.entries()) {
    if (count > 1) {
      const title = key.slice(0, key.indexOf(" "));
      duplicateTitles.push({ title, count });
    }
  }
  duplicateTitles.sort((a, b) => b.count - a.count);

  const topLocalities = [...localityCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // rules-only category baseline (instant, always available)
  const distinctTitles = [...titleCounts.keys()];
  const titleCountsPlain = {};
  for (const [title, info] of titleCounts.entries()) titleCountsPlain[title] = info.count;

  const ruleAssignment = new Map();
  const unclassifiedByRules = [];
  for (const title of distinctTitles) {
    const cat = classifyByRules(title);
    if (cat) ruleAssignment.set(title, cat);
    else unclassifiedByRules.push(title);
  }
  const rulesItems = buildCategoryItems(distinctTitles, titleCounts, ruleAssignment);

  const data = {
    jobs,
    verified,
    unverified,
    international,
    junk,
    cifMissing,
    tagsMissing,
    companies,
    distinctCompanies: companyFacet.length,
    companyStats: companyFacet.map((f) => ({ company: decodeEntities(f.value), count: f.count })),
    distinctLocalities: localityCounts.size,
    topLocalities,
    weirdExamples,
    weirdCounts,
    duplicateTitles,
    salary: {
      jobs,
      salaryFieldDocs,
      titleMoneyDocs,
      genuineSalaryDocs,
      ronMonthlyAmounts,
      hourlyOrDailyCount,
      currencyCounts,
      salarySamples,
    },
    // Everything categories() needs, without ever computing embeddings here.
    titleCounts: titleCountsPlain,
    distinctTitleCount: distinctTitles.length,
    unclassifiedByRules,
    rulesCategoryItems: rulesItems,
    scanMs: Date.now() - t0,
  };

  return data;
}

async function getBaseAggregate() {
  if (_baseMemCache && isFresh(_baseMemCache.generatedAt, BASE_TTL_MS)) return _baseMemCache;

  const disk = readJsonSafe(AGGREGATE_FILE);
  if (disk && isFresh(disk.generatedAt, BASE_TTL_MS)) {
    _baseMemCache = disk;
    return _baseMemCache;
  }

  if (_baseBuildPromise) return _baseBuildPromise;

  _baseBuildPromise = (async () => {
    const data = await buildBaseAggregate();
    const cache = { generatedAt: new Date().toISOString(), data };
    _baseMemCache = cache;
    writeJsonSafe(AGGREGATE_FILE, cache);
    _baseBuildPromise = null;
    return cache;
  })();

  return _baseBuildPromise;
}

// ---------------------------------------------------------------------
// category embeddings: the slow part. Built entirely in the background;
// categories() never awaits this directly on a cold cache.
// ---------------------------------------------------------------------

let _categoryBuildInFlight = false;

async function runCategoryBuild(base) {
  _categoryBuildInFlight = true;
  try {
    const distinctTitles = Object.keys(base.titleCounts);
    const titleCounts = new Map(distinctTitles.map((t) => [t, { count: base.titleCounts[t] }]));
    const unclassified = base.unclassifiedByRules;

    const seeds = {};
    for (const cat of RULE_CATEGORIES) seeds[cat.name] = cat.seeds;

    const ruleAssignment = new Map();
    for (const title of distinctTitles) {
      const cat = classifyByRules(title);
      if (cat) ruleAssignment.set(title, cat);
    }

    const emb = await embeddings.classifyByCentroid(unclassified, seeds, 0.5);
    const finalAssignment = new Map(ruleAssignment);
    for (const [title, { category }] of emb.entries()) finalAssignment.set(title, category);

    const items = buildCategoryItems(distinctTitles, titleCounts, finalAssignment);

    const cache = {
      generatedAt: new Date().toISOString(),
      data: {
        method: "embeddings",
        items,
        embeddingAssignedCount: emb.size,
        unclassifiedByRulesCount: unclassified.length,
        error: null,
      },
    };
    writeJsonSafe(CATEGORY_FILE, cache);
  } catch (e) {
    // Embeddings unavailable (missing package, blocked model download,
    // runtime error) - record it but do NOT throw; categories() keeps
    // serving the rules-only baseline from the base aggregate instead.
    const cache = {
      generatedAt: new Date().toISOString(),
      data: { method: "rules", items: null, error: e.message },
    };
    writeJsonSafe(CATEGORY_FILE, cache);
  } finally {
    _categoryBuildInFlight = false;
  }
}

function kickOffCategoryBuild(base) {
  if (_categoryBuildInFlight) return;
  _categoryBuildInFlight = true; // reserve the slot synchronously to avoid a duplicate kickoff race
  // Defer to the next tick: runCategoryBuild's early synchronous work (e.g.
  // loading the multi-MB on-disk vector cache the first time) must not run
  // inline on the caller's stack, or the "fire and forget" call would still
  // block whichever request happens to trigger it.
  setImmediate(() => {
    runCategoryBuild(base).catch(() => {});
  });
}

async function getCategoryResult() {
  const { data: base } = await getBaseAggregate();
  const rulesResult = { method: "rules", items: base.rulesCategoryItems };

  const disk = readJsonSafe(CATEGORY_FILE);
  if (disk && disk.data && disk.data.method === "embeddings" && Array.isArray(disk.data.items)) {
    if (!isFresh(disk.generatedAt, CATEGORY_TTL_MS)) kickOffCategoryBuild(base);
    return { method: "embeddings", items: disk.data.items };
  }

  // No usable embeddings cache yet - answer instantly with rules, warm the
  // embeddings cache in the background for the next call.
  kickOffCategoryBuild(base);
  return rulesResult;
}

// ---------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------

async function overview() {
  const { generatedAt, data } = await getBaseAggregate();
  return {
    jobs: data.jobs,
    companies: data.companies,
    verified: data.verified,
    unverified: data.unverified,
    international: data.international,
    junk: data.junk,
    distinctLocalities: data.distinctLocalities,
    distinctCompanies: data.distinctCompanies,
    generatedAt,
  };
}

async function locationStats() {
  const { data } = await getBaseAggregate();
  return {
    verified: data.verified,
    unverified: data.unverified,
    international: data.international,
    junk: data.junk,
    topLocalities: data.topLocalities.slice(0, 30),
  };
}

async function categories() {
  return getCategoryResult();
}

async function warnings() {
  const { data } = await getBaseAggregate();
  const s = data.salary;
  const missingSalaryN = s.jobs - s.genuineSalaryDocs;
  return {
    weirdTitles: data.weirdExamples.slice(0, 50),
    missingSalary: { n: missingSalaryN, pct: round((missingSalaryN / s.jobs) * 100, 2) },
    missingCif: { n: data.cifMissing, pct: round((data.cifMissing / data.jobs) * 100, 2) },
    missingTags: { n: data.tagsMissing, pct: round((data.tagsMissing / data.jobs) * 100, 2) },
    shoutingTitles: { n: data.weirdCounts.shouting },
    duplicateTitles: data.duplicateTitles.slice(0, 30),
  };
}

async function salaryStats() {
  const { data } = await getBaseAggregate();
  const s = data.salary;
  // avg/median/min/max cover only unit:"month" RON figures (salary field +
  // title regex hits that read as a lump-sum/monthly amount). Hourly rates
  // ("45 lei/oră") and daily rates ("70 Euro/zi") are genuine salary
  // signal - counted in withSalary/currency - but are NOT mixed into the
  // monthly avg/median, since 15-190 (hourly/daily) and 3000-7500
  // (monthly) are not the same unit and averaging them would be dishonest.
  const amounts = s.ronMonthlyAmounts;
  const currency = Object.entries(s.currencyCounts)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);

  return {
    withSalary: s.genuineSalaryDocs,
    withoutSalary: s.jobs - s.genuineSalaryDocs,
    pct: round((s.genuineSalaryDocs / s.jobs) * 100, 2),
    avg: amounts.length ? round(amounts.reduce((a, b) => a + b, 0) / amounts.length) : null,
    median: amounts.length ? round(median(amounts)) : null,
    min: amounts.length ? Math.min(...amounts) : null,
    max: amounts.length ? Math.max(...amounts) : null,
    currency,
    samples: s.salarySamples.slice(0, 10),
    monthlyRonSampleSize: amounts.length,
    hourlyOrDailyExcludedFromAvg: s.hourlyOrDailyCount,
  };
}

async function companyStats() {
  const { data } = await getBaseAggregate();
  return data.companyStats.slice(0, 25);
}

module.exports = {
  overview,
  locationStats,
  categories,
  warnings,
  salaryStats,
  companyStats,
};
