"use strict";
/**
 * Statistics: group-bys over the enriched jobs. Every bucket here is also a
 * filter the /api/jobs endpoint understands, so every number opens.
 *
 * Problems are counted on the whole index. Descriptive statistics (map,
 * companies, occupations) are computed on TRUSTED jobs only: a job that is
 * dead, duplicated or lying would otherwise be counted as if it were real.
 */
const { CHECKS, BY_ID, SCORED, QUESTIONS, QUESTION_OF, isAffected, evidence } = require("./checks.js");

const top = (map, n, label) => [...map.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, n)
  .map(([k, v]) => ({ [label]: k, jobs: v }));

const inc = (map, k, by = 1) => map.set(k, (map.get(k) || 0) + by);

const normCounty = (c) => String(c || "").replace(/^municipiul\s+/i, "").trim();

function freshnessBucket(age) {
  if (age == null) return "fără dată";
  if (age <= 7) return "0-7 zile";
  if (age <= 30) return "8-30 zile";
  if (age <= 90) return "31-90 zile";
  return "peste 90 zile";
}
const FRESHNESS_ORDER = ["0-7 zile", "8-30 zile", "31-90 zile", "peste 90 zile", "fără dată"];

/** which of the four questions a job fails, as a Set of question ids */
function questionsFailed(issues) {
  const out = new Set();
  for (const id of issues) if (BY_ID.get(id).severity !== "info") out.add(QUESTION_OF.get(id));
  return out;
}

const WINDOW_DAYS = 10;

function buildStats(jobs, companies, links, flow, meta) {
  const total = jobs.length;
  // Fereastra de intrări: ultimele 10 zile, după prima apariție la noi.
  // Ziua în care s-a stabilit linia de plecare nu se numără: atunci tot indexul
  // a primit prima apariție deodată, ceea ce nu înseamnă că a intrat atunci.
  const today = (flow && flow.today) || new Date().toISOString().slice(0, 10);
  const zece = new Date(Date.parse(today) - (WINDOW_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  const dupaReferinta = flow && flow.since
    ? new Date(Date.parse(flow.since) + 86400000).toISOString().slice(0, 10) : zece;
  const windowFrom = zece > dupaReferinta ? zece : dupaReferinta;
  const trusted = jobs.filter((e) => !isAffected(e.issues));

  // ---- checks and questions -------------------------------------------------
  const perCheck = new Map(CHECKS.map((c) => [c.id, 0]));
  const perCheckHosts = new Map(CHECKS.map((c) => [c.id, new Map()]));
  const perQuestion = new Map(QUESTIONS.map((q) => [q.id, 0]));
  let affected = 0, format = 0;
  const samples = new Map(CHECKS.map((c) => [c.id, []]));
  for (const e of jobs) {
    const ev = e.issues.length ? evidence(e) : null;
    for (const id of e.issues) {
      inc(perCheck, id); inc(perCheckHosts.get(id), e.host);
      const bag = samples.get(id);
      // three DIFFERENT values, so the reader sees the shape of the problem
      if (bag.length < 3 && ev[id] && !bag.some((x) => x.value === ev[id])) bag.push({ value: ev[id], url: e.url, host: e.host });
    }
    const qs = questionsFailed(e.issues);
    for (const q of qs) inc(perQuestion, q);
    if (isAffected(e.issues)) affected++;
    if (qs.has("format")) format++;
  }
  const checks = CHECKS.map((c) => ({
    id: c.id, label: c.label, why: c.why, contract: c.contract, fix: c.fix,
    dimension: c.dimension, question: QUESTION_OF.get(c.id), severity: c.severity, owner: c.owner,
    count: perCheck.get(c.id),
    samples: samples.get(c.id),
    topHosts: top(perCheckHosts.get(c.id), 3, "host"),
  }));
  const questions = QUESTIONS.map((q) => ({ ...q, affected: perQuestion.get(q.id) }));

  // ---- overview (whole index) -------------------------------------------------
  const workmode = new Map(), freshness = new Map();
  let withTags = 0, withSalary = 0;
  for (const e of jobs) {
    inc(workmode, e.workmode || "(gol)");
    inc(freshness, freshnessBucket(e.age));
    if (e.tags.length) withTags++;
    if (e.salary !== "" && !(Array.isArray(e.salary) && !e.salary.length)) withSalary++;
  }

  // ---- map (trusted) ---------------------------------------------------------------
  const counties = new Map(), localities = new Map();
  let ambiguous = 0;
  for (const e of trusted) {
    if (e.loc.kind !== "fixed") continue;                 // a trusted job always has a recognised place
    if (e.loc.county) inc(counties, normCounty(e.loc.county)); else ambiguous++;
    inc(localities, e.loc.value);
  }
  const placed = [...counties.values()].reduce((a, b) => a + b, 0);
  // the problems behind the map are counted on the whole index: they ARE the untrusted part
  const unplaced = { foreign: 0, placeholder: 0, gibberish: 0, empty: 0, ambiguous };
  const foreignPlaces = new Map(), rawUnplaced = new Map();
  for (const e of jobs) {
    if (e.loc.kind === "international") { unplaced.foreign++; inc(foreignPlaces, e.loc.value); }
    else if (e.loc.kind === "junk") {
      if (e.loc.how === "empty") unplaced.empty++; else if (e.loc.how === "placeholder") unplaced.placeholder++; else unplaced.gibberish++;
      inc(rawUnplaced, e.location.join(", ") || "(gol)");
    }
  }

  // ---- companies (trusted) ---------------------------------------------------------------
  const jobsPerCompany = new Map();
  for (const e of trusted) if (e.cifKey) inc(jobsPerCompany, e.cifKey);
  const companyRows = [];
  for (const [k, n] of jobsPerCompany) {
    const co = companies.get(k);
    companyRows.push({ cif: k, name: co ? co.name : "(nu e în catalog)", status: co ? co.status : "", jobs: n });
  }
  companyRows.sort((a, b) => b.jobs - a.jobs);
  const sizeBuckets = new Map([["1 anunț", 0], ["2-10", 0], ["11-100", 0], ["101-1000", 0], ["peste 1000", 0]]);
  for (const n of jobsPerCompany.values()) {
    inc(sizeBuckets, n === 1 ? "1 anunț" : n <= 10 ? "2-10" : n <= 100 ? "11-100" : n <= 1000 ? "101-1000" : "peste 1000");
  }
  const companyStatus = new Map();
  const allJobsPerCompany = new Set(jobs.map((e) => e.cifKey).filter(Boolean));
  let catalogWithoutJobs = 0;
  for (const co of companies.values()) { inc(companyStatus, co.status || "(gol)"); if (!allJobsPerCompany.has(co.key)) catalogWithoutJobs++; }

  // ---- occupations (trusted; COR classification is v2) -------------------------------------
  const titles = new Map(), tags = new Map();
  for (const e of trusted) { if (e.ntitle) inc(titles, e.ntitle); for (const t of e.tags) inc(tags, t); }

  // ---- sources -----------------------------------------------------------------------------
  const hosts = new Map();
  for (const e of jobs) {
    let h = hosts.get(e.host);
    if (!h) { h = { host: e.host, jobs: 0, trusted: 0, affected: 0, fresh: 0, freshAffected: 0, window: 0, windowAffected: 0, q: { exista: 0, unic: 0, adevar: 0, format: 0 }, byCheck: {} }; hosts.set(e.host, h); }
    h.jobs++;
    if (e.isNew) { h.fresh++; if (isAffected(e.issues)) h.freshAffected++; }
    if (e.firstSeen >= windowFrom) { h.window++; if (isAffected(e.issues)) h.windowAffected++; }
    const qs = questionsFailed(e.issues);
    for (const q of qs) h.q[q]++;
    if (isAffected(e.issues)) h.affected++; else h.trusted++;
    for (const id of e.issues) h.byCheck[id] = (h.byCheck[id] || 0) + 1;
  }
  const sources = [...hosts.values()].map((h) => {
    const l = links && links.byHost[h.host];
    return {
      ...h,
      pct: +(100 * h.affected / h.jobs).toFixed(0),
      share: +(100 * h.jobs / total).toFixed(1),
      topChecks: Object.entries(h.byCheck).filter(([id]) => SCORED.has(BY_ID.get(id).severity))
        .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, n]) => ({ id, label: BY_ID.get(id).label, count: n })),
      links: l ? { sampled: l.sampled, dead: l.dead, error: l.error, unreachable: l.unreachable, codes: l.codes } : null,
    };
  }).sort((a, b) => b.affected - a.affected);

  // ---- ce a intrat de la ultima analiză -------------------------------------
  // Anunțurile noi sunt singurele asupra cărora se mai poate acționa înainte
  // să ajungă în fața cuiva. Restul indexului e istorie.
  const fresh = jobs.filter((e) => e.isNew);
  const freshAffected = fresh.filter((e) => isAffected(e.issues));
  const freshByCheck = new Map();
  for (const e of fresh) for (const id of e.issues) if (BY_ID.get(id).severity === "grav") inc(freshByCheck, id);
  // aceleași cifre, dar pe fereastra de 10 zile: o zi singură e prea puțin ca
  // să se vadă dacă un scraper s-a stricat sau doar a avut o zi slabă
  const inWindow = jobs.filter((e) => e.firstSeen >= windowFrom);
  const byDay = new Map();
  for (const e of inWindow) {
    const d = byDay.get(e.firstSeen) || { day: e.firstSeen, jobs: 0, affected: 0 };
    d.jobs++; if (isAffected(e.issues)) d.affected++;
    byDay.set(e.firstSeen, d);
  }
  const windowChecks = new Map();
  for (const e of inWindow) for (const id of e.issues) if (BY_ID.get(id).severity === "grav") inc(windowChecks, id);

  const incoming = {
    window: {
      days: WINDOW_DAYS,
      from: flow && flow.since && flow.since > windowFrom ? flow.since : windowFrom,
      partial: !!(flow && flow.since && flow.since > windowFrom),
      jobs: inWindow.length,
      affected: inWindow.filter((e) => isAffected(e.issues)).length,
      byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
      hosts: [...hosts.values()].filter((h) => h.window)
        .map((h) => ({ host: h.host, window: h.window, windowAffected: h.windowAffected,
          pct: +(100 * h.windowAffected / h.window).toFixed(0) }))
        .sort((a, b) => b.windowAffected - a.windowAffected || b.window - a.window),
      checks: [...windowChecks.entries()].sort((a, b) => b[1] - a[1])
        .map(([id, n]) => ({ id, label: BY_ID.get(id).label, count: n })),
    },
    baseline: flow ? flow.baseline : true,
    since: flow ? flow.since : null,
    tracked: flow ? flow.tracked : 0,
    gone: flow ? flow.gone : 0,
    jobs: fresh.length,
    affected: freshAffected.length,
    hosts: [...hosts.values()].filter((h) => h.fresh)
      .map((h) => ({ host: h.host, fresh: h.fresh, freshAffected: h.freshAffected,
        pct: +(100 * h.freshAffected / h.fresh).toFixed(0) }))
      .sort((a, b) => b.freshAffected - a.freshAffected || b.fresh - a.fresh),
    checks: [...freshByCheck.entries()].sort((a, b) => b[1] - a[1])
      .map(([id, n]) => ({ id, label: BY_ID.get(id).label, count: n })),
  };

  return {
    ...meta,
    incoming,
    totals: { jobs: total, companies: companies.size, trusted: trusted.length, affected, format },
    questions, checks,
    overview: {
      workmode: top(workmode, 10, "value"),
      freshness: FRESHNESS_ORDER.map((b) => ({ value: b, jobs: freshness.get(b) || 0 })),
      withTags, withSalary,
    },
    map: {
      basis: trusted.length, placed, unplaced,
      counties: [...counties.entries()].map(([county, n]) => ({ county, jobs: n })).sort((a, b) => b.jobs - a.jobs),
      topLocalities: top(localities, 30, "locality"),
      topForeign: top(foreignPlaces, 20, "place"),
      topUnplaced: top(rawUnplaced, 30, "raw"),
    },
    companies: {
      basis: trusted.length,
      top: companyRows.slice(0, 40),
      sizeBuckets: [...sizeBuckets.entries()].map(([value, jobs]) => ({ value, jobs })),
      status: top(companyStatus, 10, "value"),
      distinctInTrusted: jobsPerCompany.size, distinctInJobs: allJobsPerCompany.size, catalogWithoutJobs,
      orphanJobs: perCheck.get("cif_orphan"), notActiveJobs: perCheck.get("company_not_active"),
    },
    occupations: { basis: trusted.length, topTitles: top(titles, 40, "title"), topTags: top(tags, 40, "tag"), distinctTitles: titles.size },
    sources,
    links: links ? { sampled: links.sampled, dead: links.dead, error: links.error, unreachable: links.unreachable, codes: links.codes, perHost: links.perHost } : null,
    trend: null,                                            // filled by run.js from runs/history
  };
}

module.exports = { buildStats, freshnessBucket, normCounty };
