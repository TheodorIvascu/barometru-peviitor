"use strict";
/**
 * Data layer: one bundle (loadAll) that combines
 *   - tui/validate.js's own read-only Solr scan (field validation table)
 *   - lib/analytics.js (overview / warnings / salaryStats), defensively
 *     wrapped so a missing/slow/erroring analytics.js still leaves the
 *     dashboard usable via a direct read-only Solr fallback.
 * Never writes to Solr.
 */
const path = require("path");
// Node's fetch/undici tries AAAA (::1) before A (127.0.0.1) by default. On
// this Windows box "localhost" -> ::1 connects but Solr never answers on it,
// so every request hangs for a long OS-level timeout instead of failing
// fast. Prefer IPv4 resolution so "http://localhost:8983" behaves the same
// as "http://127.0.0.1:8983" (which responds immediately).
try {
  require("dns").setDefaultResultOrder("ipv4first");
} catch {}
const { Solr } = require("../lib/solr.js");
const validate = require("./validate.js");

let analytics = null;
try {
  analytics = require(path.join(__dirname, "..", "lib", "analytics.js"));
} catch (e) {
  analytics = null;
}

const solr = new Solr();

// A slow/hanging analytics function (e.g. an uncached expensive query) must
// never leave the dashboard stuck loading forever. Race it against a
// timeout and fall back to a read-only Solr computation if it doesn't
// answer in time. The slow promise is left to resolve/reject on its own;
// we just stop waiting on it.
const ANALYTICS_TIMEOUT_MS = 4000;
// The validation scan reads more fields than analytics.js's base aggregate
// and also touches the company core, so it gets a longer budget - at
// ~90k docs a single full scan realistically needs more than 4s.
const VALIDATION_TIMEOUT_MS = 15000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out after " + ms + "ms")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function safe(fnName, fallbackFn) {
  if (analytics && typeof analytics[fnName] === "function") {
    let timedOut = false;
    try {
      const r = await withTimeout(analytics[fnName](), ANALYTICS_TIMEOUT_MS);
      if (r && typeof r === "object") return { data: r, source: "analytics" };
    } catch (e) {
      timedOut = /timed out/.test((e && e.message) || "");
      // fall through to solr fallback
    }
    try {
      const r = await fallbackFn();
      return { data: r, source: "solr", analyticsTimedOut: timedOut };
    } catch (e) {
      return { data: null, source: "error", error: e.message || String(e) };
    }
  }
  try {
    const r = await fallbackFn();
    return { data: r, source: "solr" };
  } catch (e) {
    return { data: null, source: "error", error: e.message || String(e) };
  }
}

async function ping() {
  try {
    return await solr.ping();
  } catch {
    return false;
  }
}

async function overviewFallback() {
  const [jobs, verified, international, junk] = await Promise.all([
    solr.count("*:*"),
    solr.count("verified:true"),
    solr.count("international:true"),
    solr.count("junk:true"),
  ]);
  let companies = null;
  try {
    companies = await new Solr({ core: "company" }).count("*:*");
  } catch {
    companies = null;
  }
  return { jobs, companies, verified, unverified: jobs - verified, international, junk, distinctLocalities: null, distinctCompanies: null };
}

async function warningsFallback() {
  const total = await solr.count("*:*");
  const [salaryN, cifN, tagsN] = await Promise.all([solr.count("salary:*"), solr.count("cif:*"), solr.count("tags:*")]);
  const pct = (n) => (total ? Math.round((1 - n / total) * 1000) / 10 : 0);
  return {
    weirdTitles: [],
    missingSalary: { n: total - salaryN, pct: pct(salaryN) },
    missingCif: { n: total - cifN, pct: pct(cifN) },
    missingTags: { n: total - tagsN, pct: pct(tagsN) },
    shoutingTitles: { n: null },
    duplicateTitles: [],
  };
}

async function salaryStatsFallback() {
  const total = await solr.count("*:*");
  const withSalary = await solr.count("salary:*");
  const samples = await solr.sample("salary:*", "salary", 8);
  return {
    withSalary,
    withoutSalary: total - withSalary,
    pct: total ? Math.round((withSalary / total) * 1000) / 10 : 0,
    avg: null,
    median: null,
    min: null,
    max: null,
    currency: [],
    samples: samples.map((d) => String(d.salary)).slice(0, 8),
  };
}

async function validationEntry() {
  try {
    const d = await withTimeout(validate.computeValidation(), VALIDATION_TIMEOUT_MS);
    return { data: d, source: "solr" };
  } catch (e) {
    return { data: null, source: "error", error: e.message || String(e) };
  }
}

/** One combined fetch for the whole dashboard: validation table + overview + warnings + salary. */
async function loadAll() {
  const [validation, overview, warnings, salaryStats] = await Promise.all([
    validationEntry(),
    safe("overview", overviewFallback),
    safe("warnings", warningsFallback),
    safe("salaryStats", salaryStatsFallback),
  ]);
  return { validation, overview, warnings, salaryStats, generatedAt: Date.now() };
}

module.exports = { ping, loadAll, hasAnalytics: () => !!analytics };
