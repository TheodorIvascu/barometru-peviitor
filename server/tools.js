"use strict";
/**
 * The toolbox the in-app assistant may use.
 * Thin wrappers over code that already exists and is tested.
 * Read tools run freely; writes are separate and gated.
 */
const path = require("path");
const { Solr } = require(path.join(__dirname, "..", "lib", "solr.js"));

const load = (m) => { try { return require(path.join(__dirname, "..", "lib", m)); } catch { return null; } };
const locations = load("locations.js");
const cor = load("cor.js");
const anaf = load("anaf.js");
const links = load("links.js");
const analytics = load("analytics.js");

let locIndex = null, corIndex = null;
const getLoc = () => (locIndex = locIndex || (locations && locations.loadIndex(path.join(__dirname, ".."))));
const getCor = () => (corIndex = corIndex || (cor && cor.loadCor()));
const job = () => new Solr();
const company = () => new Solr({ core: "company" });


/**
 * Hard budget per conversation turn.
 * The assistant is an overseer, not a batch processor: the deterministic
 * scripts handle 87,000+ documents at ~20,000/sec. These caps make it
 * structurally impossible for the model to chew through the whole index,
 * however it is prompted.
 */
const BUDGET = { docs: 300, anafCalls: 200, linkChecks: 50 };
let spent = { docs: 0, anafCalls: 0, linkChecks: 0 };
function resetBudget() { spent = { docs: 0, anafCalls: 0, linkChecks: 0 }; }
function spend(kind, n) {
  if (spent[kind] + n > BUDGET[kind]) {
    return `budget exceeded: this turn may read at most ${BUDGET[kind]} ${kind}. ` +
      `Use solr_count / solr_facet / data_quality_report for whole-index questions instead of reading documents one by one.`;
  }
  spent[kind] += n;
  return null;
}

const TOOLS = [
  {
    name: "solr_search",
    description: "Search the job index and return matching documents. Solr query syntax: title:sofer, location:\"Cluj-Napoca\", verified:false, company:CAREERJET, combined with AND/OR/NOT.",
    input_schema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Solr query. Use *:* for everything." },
        fields: { type: "string", description: "Comma separated fields. Default url,title,company,location,cif,workmode,salary" },
        rows: { type: "integer", description: "1-50, default 10" },
        sort: { type: "string", description: "e.g. 'date desc'" },
      },
      required: ["q"],
    },
    run: async ({ q, fields, rows, sort }) => {
      const fl = fields || "url,title,company,location,cif,workmode,salary";
      const n = Math.min(Math.max(rows || 10, 1), 50);
      let u = "/select?q=" + encodeURIComponent(q) + "&fl=" + encodeURIComponent(fl) + "&rows=" + n + "&wt=json";
      if (sort) u += "&sort=" + encodeURIComponent(sort);
      const over = spend("docs", n);
      if (over) return { error: over, numFound: await job().count(q) };
      const r = await job()._get(u);
      return { numFound: r.response.numFound, docs: r.response.docs };
    },
  },
  {
    name: "solr_count",
    description: "Count jobs matching a query. Cheap - use before fetching documents, and for statistics.",
    input_schema: { type: "object", properties: { q: { type: "string", description: "Solr query" } }, required: ["q"] },
    run: async ({ q }) => ({ q, count: await job().count(q) }),
  },
  {
    name: "solr_facet",
    description: "Group jobs by a field with counts, sorted desc. Good for top companies or workmode breakdown. The location field is tokenised so facet on company/workmode/status instead.",
    input_schema: {
      type: "object",
      properties: {
        field: { type: "string", description: "company, workmode, status, ..." },
        q: { type: "string", description: "restrict, default *:*" },
        limit: { type: "integer", description: "default 20" },
      },
      required: ["field"],
    },
    run: async ({ field, q, limit }) => ({ field, values: await job().facet(field, q || "*:*", limit || 20) }),
  },
  {
    name: "data_quality_report",
    description: "Overall health of the index: totals, verified/international/junk location counts, field coverage, salary stats, top localities and companies. Start here when asked how the data looks.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      if (!analytics) return { error: "analytics module not available" };
      const [overview, loc, warn, sal] = await Promise.all([
        analytics.overview(), analytics.locationStats(), analytics.warnings(), analytics.salaryStats(),
      ]);
      return { overview, locations: loc, warnings: warn, salary: sal };
    },
  },
  {
    name: "quality_checks",
    description: "The measured rule registry: every data-quality rule with its exact count, percentage, severity and health score. This is the SOURCE OF TRUTH for 'what is wrong with the data'. Always call this before describing any defect - never guess counts or explanations.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      const rules = require(require("path").join(__dirname, "..", "lib", "rules.js"));
      const { total, at, rules: list } = await rules.counts();
      return { total, scannedAt: at, score: rules.score(list).score, rules: list };
    },
  },
  {
    name: "issue_examples",
    description: "Real job rows behind one rule id (from quality_checks). Use this to show WHICH jobs are affected instead of describing them in the abstract. Returns at most 20 rows.",
    input_schema: { type: "object", properties: { issue: { type: "string", description: "rule id, e.g. loc_junk, title_adult, cif_orphan" }, limit: { type: "number" } }, required: ["issue"] },
    run: async ({ issue, limit }) => {
      const jobs = require(require("path").join(__dirname, "jobs.js"));
      const n = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 20);
      const out = await jobs.getJobs({ query: { issue, limit: String(n), offset: "0" } });
      if (out.status !== 200) return { error: out.body.error, hint: out.body.hint };
      return { issue, total: out.body.total, rows: out.body.rows };
    },
  },
  {
    name: "top_values",
    description: "Exact value counts for a string field: location_s (canonical locality), company, workmode, status, loc_kind. NOTE: the raw `location` field is tokenized text, so faceting it returns word fragments like 'cluj'/'napoca' - always use location_s for locality counts.",
    input_schema: { type: "object", properties: { field: { type: "string" }, limit: { type: "number" } }, required: ["field"] },
    run: async ({ field, limit }) => {
      const jobs = require(require("path").join(__dirname, "jobs.js"));
      const out = await jobs.getTop({ query: { field, limit: String(Math.min(parseInt(limit, 10) || 20, 50)) } });
      return out.status === 200 ? out.body : { error: out.body.error };
    },
  },
  {
    name: "location_check",
    description: "Check one location string against the official SIRUTA registry. Says whether it is a real Romanian locality (with canonical spelling), a foreign place, or not a location at all. Handles typos, street addresses, postal codes and Bucharest sectors.",
    input_schema: { type: "object", properties: { value: { type: "string", description: "raw location text" } }, required: ["value"] },
    run: async ({ value }) => {
      if (!locations) return { error: "locations module not available" };
      return Object.assign({ input: value }, locations.classify(value, getLoc()));
    },
  },
  {
    name: "occupation_match",
    description: "Map a job title to an official COR occupation code (Clasificarea Ocupatiilor din Romania). Returns null when it cannot match confidently - that is a valid answer, not a failure.",
    input_schema: { type: "object", properties: { title: { type: "string", description: "job title" } }, required: ["title"] },
    run: async ({ title }) => {
      if (!cor) return { error: "cor module not available" };
      return { title, match: cor.matchTitle(title, getCor()) || null };
    },
  },
  {
    name: "company_verify",
    description: "Verify Romanian company registration numbers (CIF/CUI) against ANAF, the official tax authority. Returns official name, address, registration and VAT status. Their API allows 1 request/second, so keep lists short.",
    input_schema: { type: "object", properties: { cifs: { type: "array", items: { type: "string" }, description: "up to 100 CIFs" } }, required: ["cifs"] },
    run: async ({ cifs }) => {
      if (!anaf) return { error: "anaf module not available" };
      const list = (cifs || []).slice(0, 100);
      const over = spend("anafCalls", list.length);
      if (over) return { error: over };
      return { checked: list.length, results: await anaf.verify(list) };
    },
  },
  {
    name: "links_check",
    description: "Check whether job links are still alive. Distinguishes dead (404) from blocked (403 - site alive but refuses bots). Rate limited per host. Keep the list under 20.",
    input_schema: { type: "object", properties: { urls: { type: "array", items: { type: "string" }, description: "job URLs" } }, required: ["urls"] },
    run: async ({ urls }) => {
      if (!links) return { error: "links module not available" };
      const list = (urls || []).slice(0, 20);
      const over = spend("linkChecks", list.length);
      if (over) return { error: over };
      const { results, summary } = await links.check(list);
      return { summary, results };
    },
  },
  {
    name: "company_lookup",
    description: "Look up a company in the local company core by exact CIF or by name fragment.",
    input_schema: { type: "object", properties: { cif: { type: "string" }, name: { type: "string" } } },
    run: async ({ cif, name }) => {
      const q = cif ? "id:" + JSON.stringify(String(cif)) : "company:" + JSON.stringify(String(name || "*"));
      const r = await company()._get("/select?q=" + encodeURIComponent(q) + "&rows=10&wt=json");
      return { numFound: r.response.numFound, docs: r.response.docs };
    },
  },
];

const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const toolSpecs = () => TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));

async function runTool(name, input) {
  const t = BY_NAME[name];
  if (!t) return { error: "unknown tool: " + name };
  try { return await t.run(input || {}); }
  catch (e) { return { error: String(e.message).slice(0, 300) }; }
}

module.exports = { TOOLS, toolSpecs, runTool, resetBudget, BUDGET };
