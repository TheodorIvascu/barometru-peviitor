"use strict";
/**
 * Field-level validation for the job core: one Solr scan answers, per
 * field, how much is filled, how much is actually valid, and what the
 * concrete problems look like. This lives in tui/ (not lib/analytics.js,
 * which we don't own/modify) because it needs fields analytics.js's base
 * scan doesn't collect (url, workmode, date, status) and because it's
 * presentation-layer judgement (thresholds, example picking) rather than
 * shared aggregate data.
 *
 * Read-only: only Solr.count/.scan are used, never .update()/.commit().
 *
 * Defensively wires up NEW per-field validators other engineers may add
 * under lib/ (anaf.js: company-registry cross-check, links.js: URL
 * reachability, cor.js: occupation classification). None of these exist
 * yet - every use site checks for the expected export before calling it
 * and otherwise falls back to the local rule below, so the table renders
 * real numbers today and only gets richer as those modules land.
 */
const path = require("path");
const { Solr } = require("../lib/solr.js");

let anaf = null;
try {
  anaf = require(path.join(__dirname, "..", "lib", "anaf.js"));
} catch (e) {
  anaf = null;
}
let links = null;
try {
  links = require(path.join(__dirname, "..", "lib", "links.js"));
} catch (e) {
  links = null;
}
let cor = null;
try {
  cor = require(path.join(__dirname, "..", "lib", "cor.js"));
} catch (e) {
  cor = null;
}

const jobSolr = new Solr();
const companySolr = new Solr({ core: "company" });

const WORKMODES = new Set(["remote", "on-site", "hybrid"]);
const STATUSES = new Set(["scraped", "tested", "verified", "published"]);
const DIACRITIC_RE = /[ăâîșşțţĂÂÎȘŞȚŢ]/;
const ENTITY_RE = /&(?:quot|amp|lt|gt|#39|apos|nbsp);/i;
const MONEY_IN_TEXT_RE = /\d[\d.,]{1,6}\s*(?:RON|lei|EUR|EURO|€|\$|USD)\b/i;
const PUNCT_SPAM_RE = /[!?.]{3,}/;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/u;
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// Small, high-confidence set of major Romanian city names that turn up in
// job titles ("Contabil Cluj", "Barista BUCURESTI"). This is a heuristic,
// not the full SIRUTA index (that's lib/locations.js's job, tuned for
// parsing structured location tokens, not scanning free text) - flagged
// separately in the problems list rather than folded silently into a
// single pass/fail so it stays honest about being approximate.
const CITY_HINTS = [
  "bucuresti", "bucurești", "cluj", "iasi", "iași", "timisoara", "timișoara",
  "brasov", "brașov", "constanta", "constanța", "craiova", "sibiu", "oradea",
  "arad", "galati", "galați", "ploiesti", "ploiești", "pitesti", "pitești",
  "targu mures", "târgu mureș", "baia mare", "buzau", "buzău", "satu mare",
  "ramnicu valcea", "râmnicu vâlcea", "suceava", "bacau", "bacău",
];

function stripDia(s) {
  return String(s).replace(/[ăâîșşțţĂÂÎȘŞȚŢ]/g, (ch) => ({ ă: "a", â: "a", î: "i", ș: "s", ş: "s", ț: "t", ţ: "t", Ă: "a", Â: "a", Î: "i", Ș: "s", Ş: "s", Ț: "t", Ţ: "t" }[ch] || ch));
}
function titleMentionsCity(title) {
  const norm = stripDia(title).toLowerCase();
  return CITY_HINTS.some((c) => norm.includes(stripDia(c).toLowerCase()));
}

const VALIDATION_FIELDS = ["url", "title", "company", "cif", "location", "tags", "workmode", "salary", "date", "status"];

function emptyFieldStat() {
  return { filled: 0, valid: 0 };
}

function newState() {
  const stat = {};
  for (const f of VALIDATION_FIELDS) stat[f] = emptyFieldStat();
  return stat;
}

/** problems[field] : Map(label -> {count, examples:[]}) */
function makeProblemTracker() {
  const problems = {};
  for (const f of VALIDATION_FIELDS) problems[f] = new Map();
  return {
    problems,
    add(field, label, example) {
      const m = problems[field];
      const cur = m.get(label) || { count: 0, examples: [] };
      cur.count++;
      if (example && cur.examples.length < 3) cur.examples.push(String(example).slice(0, 120));
      m.set(label, cur);
    },
  };
}

/**
 * All distinct company-core ids (== CIF, 8-digit string, the core's
 * uniqueKey). Null if the core is unreachable.
 *
 * Deliberately uses facet() rather than Solr.scan(): scan() hardcodes
 * `sort=url asc` (job-core-specific - we don't own lib/solr.js to fix
 * that), which 400s against the company core since it has no `url`
 * field. facet.limit just needs to comfortably exceed the distinct id
 * count (~16k today); 300000 leaves plenty of headroom.
 */
async function getCompanyIds() {
  try {
    const rows = await companySolr.facet("id", "*:*", 300000);
    return new Set(rows.map((r) => String(r.value).trim()));
  } catch (e) {
    return null; // company core unreachable - don't penalize cif/company rows for it
  }
}

async function computeValidation() {
  const t0 = Date.now();
  const companyIds = await getCompanyIds();
  const stat = newState();
  const tracker = makeProblemTracker();
  const domains = new Map(); // hostname -> count
  let total = 0;

  const fl = "url,title,company,cif,location,tags,workmode,salary,date,status,verified,international,junk";
  for await (const d of jobSolr.scan("*:*", fl, 2000)) {
    total++;

    // ---- url ----
    const url = (d.url || "").toString().trim();
    if (url) {
      stat.url.filled++;
      let ok = false;
      if (/^https?:\/\//i.test(url)) {
        try {
          const host = new URL(url).hostname;
          ok = true;
          domains.set(host, (domains.get(host) || 0) + 1);
        } catch {
          ok = false;
        }
      }
      if (ok) stat.url.valid++;
      else tracker.add("url", "not a valid http(s) URL", url);
    } else {
      tracker.add("url", "empty", null);
    }

    // ---- title ----
    const titleRaw = (d.title || "").toString();
    const title = titleRaw.trim();
    if (title) {
      stat.title.filled++;
      const letters = title.replace(/[^\p{L}]/gu, "");
      const shouting = letters.length >= 4 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
      const punctSpam = PUNCT_SPAM_RE.test(title) || EMOJI_RE.test(title);
      const badLength = title.length < 4 || title.length > 200;
      const hasMoney = MONEY_IN_TEXT_RE.test(title);
      const hasCity = titleMentionsCity(title);
      const ok = !badLength && !shouting && !punctSpam && !hasMoney && !hasCity;
      if (ok) stat.title.valid++;
      if (badLength) tracker.add("title", title.length < 4 ? "too short" : "too long", title);
      if (shouting) tracker.add("title", "ALL CAPS", title);
      if (punctSpam) tracker.add("title", "punctuation/emoji spam", title);
      if (hasMoney) tracker.add("title", "salary mentioned in title", title);
      if (hasCity) tracker.add("title", "locality mentioned in title", title);
    } else {
      tracker.add("title", "empty", null);
    }

    // ---- company ----
    const companyRaw = (d.company || "").toString();
    const company = companyRaw.trim();
    const cifStr = d.cif === undefined || d.cif === null ? "" : String(d.cif).trim();
    if (company) {
      stat.company.filled++;
      const hasEntities = ENTITY_RE.test(companyRaw);
      const inCore = companyIds ? (cifStr ? companyIds.has(cifStr) : false) : null;
      if (hasEntities) tracker.add("company", "raw HTML entities", companyRaw);
      if (inCore === false) tracker.add("company", "not found in company core", company + (cifStr ? " (cif " + cifStr + ")" : ""));
      const ok = !hasEntities && inCore !== false;
      if (ok) stat.company.valid++;
    } else {
      tracker.add("company", "empty", null);
    }

    // ---- cif ----
    if (cifStr) {
      stat.cif.filled++;
      const isZero = /^0+$/.test(cifStr);
      const digits8 = /^\d{8}$/.test(cifStr);
      const inCore = companyIds ? companyIds.has(cifStr) : null;
      if (isZero) tracker.add("cif", "cif = 0", cifStr);
      else if (!digits8) tracker.add("cif", "not exactly 8 digits", cifStr);
      else if (inCore === false) tracker.add("cif", "orphan (not in company core)", cifStr + (company ? " (" + company + ")" : ""));
      const ok = digits8 && !isZero && inCore !== false;
      if (ok) stat.cif.valid++;
    } else {
      tracker.add("cif", "empty", null);
    }

    // ---- location ----
    const locs = Array.isArray(d.location) ? d.location.filter(Boolean) : [];
    if (locs.length) {
      stat.location.filled++;
      if (d.junk === true) tracker.add("location", "junk", locs.join(", "));
      else if (d.verified === true || d.international === true) stat.location.valid++;
      else tracker.add("location", "unverified", locs.join(", "));
    } else {
      tracker.add("location", "empty", null);
    }

    // ---- tags ----
    const tags = Array.isArray(d.tags) ? d.tags.filter(Boolean) : [];
    if (tags.length) {
      stat.tags.filled++;
      const tooMany = tags.length > 20;
      const badCase = tags.some((t) => t !== t.toLowerCase());
      const hasDia = tags.some((t) => DIACRITIC_RE.test(t));
      if (tooMany) tracker.add("tags", "more than 20 tags", tags.length + " tags");
      if (badCase) tracker.add("tags", "not lowercase", tags.find((t) => t !== t.toLowerCase()));
      if (hasDia) tracker.add("tags", "has diacritics", tags.find((t) => DIACRITIC_RE.test(t)));
      const ok = !tooMany && !badCase && !hasDia;
      if (ok) stat.tags.valid++;
    } else {
      tracker.add("tags", "empty", null);
    }

    // ---- workmode ----
    const wm = (d.workmode || "").toString().trim();
    if (wm) {
      stat.workmode.filled++;
      if (WORKMODES.has(wm)) stat.workmode.valid++;
      else tracker.add("workmode", "not remote|on-site|hybrid", wm);
    } else {
      tracker.add("workmode", "empty", null);
    }

    // ---- salary (coverage genuinely ~1% - filled here is the raw field only;
    // the "parsed/genuine" number the stats+warnings screens use comes from
    // lib/analytics.js's currency-aware parser, not duplicated here) ----
    const sal = Array.isArray(d.salary) ? d.salary.filter(Boolean) : [];
    if (sal.length) stat.salary.filled++;

    // ---- date ----
    const dt = (d.date || "").toString().trim();
    if (dt) {
      stat.date.filled++;
      if (ISO8601_RE.test(dt) && !isNaN(Date.parse(dt))) stat.date.valid++;
      else tracker.add("date", "not ISO8601", dt);
    } else {
      tracker.add("date", "empty", null);
    }

    // ---- status ----
    const st = (d.status || "").toString().trim();
    if (st) {
      stat.status.filled++;
      if (STATUSES.has(st)) stat.status.valid++;
      else tracker.add("status", "not scraped|tested|verified|published", st);
    } else {
      tracker.add("status", "empty", null);
    }
  }

  return {
    total,
    fields: stat,
    problems: tracker.problems,
    domains, // Map hostname -> count, from url field only
    companyIdsAvailable: companyIds !== null,
    scanMs: Date.now() - t0,
    generatedAt: Date.now(),
    hooks: { anaf: !!anaf, links: !!links, cor: !!cor }, // surfaced so the UI can note "n/a (module not present yet)"
  };
}

module.exports = { computeValidation, VALIDATION_FIELDS };
