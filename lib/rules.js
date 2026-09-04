"use strict";
/**
 * lib/rules.js - the rule registry. This is the spine of the whole tool.
 *
 * A rule is a QUERY. Its count is just that query's COUNT(*), and its rows are
 * the same query paged. The number on screen and the job list behind it are two
 * renderings of one thing, so a count can never disagree with its evidence.
 *
 * Two tiers, one interface:
 *
 *   tier "solr"  - q is a Solr query. Count and drill-down both hit Solr
 *                  directly; nothing is cached. Only safe on `string` fields
 *                  (cif, company, url, loc_kind, workmode, status) - `location`,
 *                  `title` and `tags` are text_general, so an exact-value query
 *                  on them silently matches tokens instead of values.
 *
 *   tier "scan"  - test(doc, ctx) is a JS predicate. One pass over the index
 *                  evaluates EVERY scan rule at once and stores the matching
 *                  urls in cache/rules.json, so a drill-down is a slice plus a
 *                  fetch-by-url rather than a re-scan of 58k documents.
 *
 *   tier "judge" - `judge` names a spec in lib/judge.js. The candidate set is
 *                  produced by ANOTHER rule (`source`); the verdict on each
 *                  candidate comes from the model and is cached per url with
 *                  the model id and a prompt hash, so a row is judged once.
 *                  The count is the number of candidates the model CONFIRMED,
 *                  which makes a judged rule strictly a subset of the rule
 *                  feeding it. The model never sees the index - only the
 *                  handful of rows a deterministic rule already flagged.
 *
 *                  This tier is only for rules whose hits must be READ, not
 *                  matched. If a regex decides it correctly, it stays a regex.
 *                  See ANALIZA-AI.md for which rules qualify and why.
 *
 * Severity drives the health score. "cosmetic" rules (weight 3 or less) are
 * deliberately kept visible but cannot meaningfully move the number - that is
 * the structural answer to a checklist that used to shout about ALL-CAPS.
 */
const path = require("path");
const fs = require("fs");
const { Solr } = require(path.join(__dirname, "solr.js"));

const CACHE = path.join(__dirname, "..", "cache", "rules.json");

/** Derived location data lives BESIDE the index, never inside it: the
 *  peviitor_core schema is the authority and this tool must not add fields to
 *  it. classify.js writes cache/locations.json keyed by job url. */
const LOC_CACHE = path.join(__dirname, "..", "cache", "locations.json");
function readLocations() {
  try {
    const j = JSON.parse(fs.readFileSync(LOC_CACHE, "utf8"));
    return j && j.derived ? j.derived : null;
  } catch { return null; }
}



// ---------------------------------------------------------------------------
// helpers used by the predicates
// ---------------------------------------------------------------------------

/** CIFs are stored zero-padded in `job` and bare in `company`. Comparing them
 *  raw reports 9,410 orphan jobs; comparing them normalized reports 19. */
const cifKey = (v) => String(v == null ? "" : v).trim().replace(/^RO/i, "").replace(/^0+/, "");

/** official Romanian CIF checksum, key 753217532 */
function cifChecksumOk(raw) {
  const s = cifKey(raw);
  if (!/^\d{2,10}$/.test(s)) return false;
  const KEY = "753217532";
  const body = s.slice(0, -1), check = Number(s.slice(-1));
  const padded = body.padStart(9, "0");
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(padded[i]) * Number(KEY[i]);
  const r = (sum * 10) % 11;
  return (r === 10 ? 0 : r) === check;
}

const ADULT = /\b(videochat|video\s*chat|escort[aă]?|masaj\s+erotic|erotic|striptease|strip\s*club|dansatoare|animatoare|hostess\s+club|sex[iy]|adult)\b/i;
const CONTACT = /(\+?\d[\d\s().-]{7,}\d)|([\w.+-]+@[\w-]+\.[a-z]{2,})/i;
const HTML_ENT = /&(amp|quot|lt|gt|#\d+|nbsp|apos);/i;

/** a title is ALL-CAPS if it has letters and none of them are lowercase */
function isAllCaps(t) {
  const s = String(t || "");
  return /[A-ZĂÂÎȘȚ]/.test(s) && !/[a-zăâîșț]/.test(s);
}

// ---------------------------------------------------------------------------
// peviitor_core contract helpers
//
// These encode the Job / Company model exactly as peviitor_core defines it.
// The schema is the authority: this tool VALIDATES against it and must never
// be the reason a field definition changes.
// ---------------------------------------------------------------------------

const DIACRITICS = /[ăâîșțĂÂÎȘȚşŞţŢ]/;
const HTML_TAG = /<[^>]+>/;
const WORKMODES = new Set(["remote", "on-site", "hybrid"]);
const STATUSES = new Set(["scraped", "tested", "published", "verified"]);

/** salary contract: "MIN-MAX CURRENCY" or a single "N CURRENCY", string only */
const SALARY_RE = /^\s*\d[\d.\s]*(?:-\s*\d[\d.\s]*)?\s*[A-Z]{3}\s*$/;

/** company id contract: exactly 8 digits, no RO prefix */
const CIF8 = /^\d{8}$/;

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------

const RULES = [
  // ---- locations ---------------------------------------------------------
  {
    id: "loc_junk",
    label: "Locații invalide",
    hint: "Valori ca „all”, „Nespecificat”, „Toate”, coduri interne — nu spun nimic despre unde e jobul.",
    group: "Locații", severity: "blocant", weight: 12,
    tier: "scan", needs: "url,title,company,location",
    test: (d, ctx) => ctx.loc(d.url) === "junk",
  },
  {
    id: "loc_country",
    label: "Locații doar la nivel de țară",
    hint: "„Romania” / „Remote, Romania” — corect pentru un job remote, doar mai puțin precis decât o localitate.",
    group: "Locații", severity: "info", weight: 2,
    tier: "scan", needs: "url,title,company,location",
    test: (d, ctx) => ctx.loc(d.url) === "country",
  },
  {
    id: "loc_international",
    label: "Locații din afara României",
    hint: "Joburi reale, dar în străinătate — de etichetat, nu de șters.",
    group: "Locații", severity: "avertisment", weight: 5,
    tier: "scan", needs: "url,title,company,location",
    test: (d, ctx) => ctx.loc(d.url) === "international",
  },
  // ---- companies / CIF ---------------------------------------------------
  {
    id: "cif_orphan",
    label: "Joburi fără companie în catalog",
    hint: "CIF-ul jobului nu există în core-ul `company` (zerourile din față ignorate).",
    group: "Companii", severity: "blocant", weight: 10,
    tier: "scan", needs: "url,title,company,cif,location",
    test: (d, ctx) => !ctx.companyIds.has(cifKey(d.cif)),
  },
  {
    id: "cif_bad_checksum",
    label: "CIF invalid",
    hint: "Nu trece cifra de control oficială — nu poate fi un CIF real.",
    group: "Companii", severity: "blocant", weight: 10,
    tier: "scan", needs: "url,title,company,cif,location",
    test: (d) => !cifChecksumOk(d.cif),
  },
  {
    id: "company_html_entity",
    label: "Nume de companie cu HTML nedecodat",
    hint: "„IONUT&amp;MADA S.R.L.” — scăpare de la scraper.",
    group: "Companii", severity: "avertisment", weight: 5,
    tier: "scan", needs: "url,title,company,cif,location",
    test: (d) => HTML_ENT.test(d.company || ""),
  },

  // ---- titles ------------------------------------------------------------
  {
    id: "title_adult",
    label: "Conținut pentru adulți",
    hint: "Videochat, escortă, masaj erotic. Cuvinte ca „animatoare” apar și în joburi nevinovate — verifică rândurile.",
    group: "Titluri", severity: "blocant", weight: 20,
    tier: "scan", needs: "url,title,company,location",
    test: (d) => ADULT.test(d.title || ""),
  },
  {
    id: "title_contact",
    label: "Telefon sau email în titlu",
    hint: "Date de contact scăpate în titlu de scraper.",
    group: "Titluri", severity: "avertisment", weight: 6,
    tier: "scan", needs: "url,title,company,location",
    test: (d) => CONTACT.test(d.title || ""),
  },
  {
    id: "title_too_short",
    label: "Titluri inutilizabile",
    hint: "Sub 3 caractere sau doar cifre.",
    group: "Titluri", severity: "blocant", weight: 8,
    tier: "scan", needs: "url,title,company,location",
    test: (d) => {
      const t = String(d.title || "").trim();
      return t.length < 3 || /^[\d\W_]+$/.test(t);
    },
  },
  {
    id: "title_allcaps",
    label: "Titluri cu majuscule",
    hint: "Cosmetic. Menționat, dar nu mișcă scorul.",
    group: "Titluri", severity: "cosmetic", weight: 3,
    tier: "scan", needs: "url,title,company,location",
    test: (d) => isAllCaps(d.title),
  },
  {
    id: "dup_title_company",
    label: "Joburi duplicate",
    hint: "Același titlu la aceeași companie, postat de mai multe ori.",
    group: "Titluri", severity: "avertisment", weight: 8,
    tier: "scan", needs: "url,title,company,location",
    pass2: true,
  },

  // ---- completeness ------------------------------------------------------
  {
    id: "missing_workmode",
    label: "Fără mod de lucru",
    hint: "Nu se știe dacă e la birou, hibrid sau remote.",
    group: "Completitudine", severity: "info", weight: 4,
    tier: "solr", q: "-workmode:*",
  },
  {
    id: "missing_tags",
    label: "Fără etichete",
    hint: "Jobul nu apare în filtrele pe domeniu.",
    group: "Completitudine", severity: "info", weight: 4,
    tier: "solr", q: "-tags:*",
  },

  // ---- conformitate cu contractul peviitor_core ---------------------------
  // Fiecare regulă de aici citează o cerință explicită din Job Model Schema.
  {
    id: "company_not_uppercase",
    label: "Companie care nu e cu majuscule",
    hint: "Contractul cere denumirea legală, scrisă întotdeauna cu MAJUSCULE.",
    group: "Contract", severity: "avertisment", weight: 5,
    tier: "scan", needs: "url,title,company,cif,location",
    test: (d) => {
      const c = String(d.company || "").trim();
      return !!c && c !== c.toUpperCase();
    },
  },
  {
    id: "cif_not_8_digits",
    label: "CIF cu alt număr de cifre",
    hint: "Contractul cere exact 8 cifre, fără prefixul RO — așa se leagă de core-ul `company`.",
    group: "Contract", severity: "avertisment", weight: 6,
    tier: "scan", needs: "url,title,company,cif,location",
    test: (d) => {
      const c = String(d.cif == null ? "" : d.cif).trim();
      return !!c && !CIF8.test(c);
    },
  },
  {
    id: "tags_with_diacritics",
    label: "Etichete cu diacritice",
    hint: "Contractul cere etichete fără diacritice, ca să se potrivească între surse.",
    group: "Contract", severity: "avertisment", weight: 5,
    tier: "scan", needs: "url,title,company,tags",
    test: (d) => asArray(d.tags).some((t) => DIACRITICS.test(String(t))),
  },
  {
    id: "tags_not_lowercase",
    label: "Etichete scrise cu majuscule",
    hint: "Contractul cere etichete cu litere mici; astea au majuscule.",
    group: "Contract", severity: "info", weight: 3,
    tier: "scan", needs: "url,title,company,tags",
    test: (d) => asArray(d.tags).some((t) => String(t) !== String(t).toLowerCase()),
  },
  {
    id: "tags_too_many",
    label: "Prea multe etichete",
    hint: "Contractul limitează la 20 de etichete pe job.",
    group: "Contract", severity: "info", weight: 3,
    tier: "scan", needs: "url,title,company,tags",
    test: (d) => asArray(d.tags).length > 20,
  },
  {
    id: "workmode_invalid",
    label: "Mod de lucru necunoscut",
    hint: "Contractul permite doar „remote”, „on-site” sau „hybrid”.",
    group: "Contract", severity: "blocant", weight: 8,
    tier: "scan", needs: "url,title,company,workmode",
    test: (d) => {
      const w = String(d.workmode == null ? "" : d.workmode).trim();
      return !!w && !WORKMODES.has(w);
    },
  },
  {
    id: "status_invalid",
    label: "Status în afara fluxului",
    hint: "Contractul permite doar scraped → tested / verified → published.",
    group: "Contract", severity: "blocant", weight: 8,
    tier: "scan", needs: "url,title,company,status",
    test: (d) => {
      const st = String(d.status == null ? "" : d.status).trim();
      return !!st && !STATUSES.has(st);
    },
  },
  {
    id: "title_too_long",
    label: "Titluri prea lungi",
    hint: "Contractul limitează titlul la 200 de caractere.",
    group: "Contract", severity: "avertisment", weight: 5,
    tier: "scan", needs: "url,title,company,location",
    test: (d) => String(d.title || "").length > 200,
  },
  {
    id: "title_html",
    label: "HTML în titlu",
    hint: "Contractul cere titlu curat, fără marcaj HTML.",
    group: "Contract", severity: "blocant", weight: 8,
    tier: "scan", needs: "url,title,company,location",
    test: (d) => HTML_TAG.test(String(d.title || "")) || HTML_ENT.test(String(d.title || "")),
  },
  {
    id: "title_untrimmed",
    label: "Titluri cu spații în plus",
    hint: "Contractul cere titlul cu spațiile tăiate.",
    group: "Contract", severity: "info", weight: 2,
    tier: "scan", needs: "url,title,company,location",
    test: (d) => {
      const t = String(d.title == null ? "" : d.title);
      return !!t && t !== t.trim();
    },
  },
  {
    id: "salary_bad_format",
    label: "Salariu în format greșit",
    hint: "Contractul cere „MIN-MAX MONEDĂ” ca text, de exemplu „5000-8000 RON”.",
    group: "Contract", severity: "avertisment", weight: 4,
    tier: "scan", needs: "url,title,company,salary",
    test: (d) => {
      if (d.salary == null) return false;
      if (Array.isArray(d.salary)) return true;        // contractul cere string, nu listă
      const v = String(d.salary).trim();
      return !!v && !SALARY_RE.test(v);
    },
  },
  {
    id: "url_broken",
    label: "URL-uri stricate",
    hint: "Nu duc la anunț: căi relative fără domeniu, spații în adresă, sau „mailto:”. Nu e vorba de http vs https.",
    group: "Contract", severity: "blocant", weight: 10,
    tier: "scan", needs: "url,title,company,location",
    test: (d) => {
      const u = String(d.url || "");
      if (!u) return true;
      if (!/^https?:\/\//i.test(u)) return true;      // relative path, mailto:, anything schemeless
      if (/\s/.test(u)) return true;                   // a space breaks the link
      return false;
    },
  },
];

const byId = new Map(RULES.map((r) => [r.id, r]));

// ---------------------------------------------------------------------------
// materialization - one scan evaluates every "scan" rule
// ---------------------------------------------------------------------------

async function materialize({ onProgress } = {}) {
  const t0 = Date.now();
  const job = new Solr({ core: "job" });
  const company = new Solr({ core: "company" });

  const companyIds = new Set();
  for await (const d of company.scan("*:*", "id", 1000, "id asc")) companyIds.add(cifKey(d.id));

  const scanRules = RULES.filter((r) => r.tier === "scan" && !r.pass2);
  const derived = readLocations() || Object.create(null);
  const ctx = {
    companyIds,
    derived,
    loc: (url) => { const e = derived[url]; return e ? e.kind : null; },
  };
  const hits = {};
  for (const r of RULES) if (r.tier === "scan") hits[r.id] = [];

  // union of every field any scan rule needs
  const fl = [...new Set(RULES.filter((r) => r.tier === "scan").flatMap((r) => (r.needs || "").split(",")))]
    .filter(Boolean).join(",");

  const dupSeen = new Map();     // title|company -> first url
  let scanned = 0;
  for await (const d of job.scan("*:*", fl)) {
    scanned++;
    for (const r of scanRules) {
      try { if (r.test(d, ctx)) hits[r.id].push(d.url); } catch { /* a bad doc must not kill the pass */ }
    }
    const k = String(d.title || "").trim().toLowerCase() + "|" + String(d.company || "").trim().toLowerCase();
    if (dupSeen.has(k)) {
      const first = dupSeen.get(k);
      if (first) { hits.dup_title_company.push(first); dupSeen.set(k, null); }
      hits.dup_title_company.push(d.url);
    } else {
      dupSeen.set(k, d.url);
    }
    if (onProgress && scanned % 10000 === 0) onProgress(scanned);
  }

  const out = {
    at: new Date().toISOString(),
    seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    scanned,
    counts: Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, v.length])),
    hits,
  };
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(out), "utf8");
  return out;
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return null; }
}

// ---------------------------------------------------------------------------
// counts + health score
// ---------------------------------------------------------------------------

async function counts() {
  const job = new Solr({ core: "job" });
  const total = await job.count("*:*");
  const cache = readCache();
  const out = [];
  for (const r of RULES) {
    let count = null, measured = true, judge = null;
    if (r.tier === "solr") {
      count = await job.count(r.q);
    } else if (r.tier === "judge") {
      // never calls the model: reads cached verdicts only
      const j = require(path.join(__dirname, "judge.js"));
      judge = await j.summary(r.judge);
      count = judge && judge.candidates != null ? judge.confirmed : null;
      // a judged rule is "measured" only when EVERY candidate has a verdict;
      // a half-judged rule must not quietly report a smaller number as fact
      measured = !!(judge && judge.measured);
      if (judge && judge.candidates === 0) { count = 0; measured = true; }
    } else if (cache && cache.counts && r.id in cache.counts) {
      count = cache.counts[r.id];
    } else {
      measured = false;                 // never scanned - shown as "nemăsurat"
    }
    const row = {
      id: r.id, label: r.label, hint: r.hint, group: r.group,
      severity: r.severity, weight: r.weight,
      count, measured,
      pct: measured && total && count != null ? +(count / total * 100).toFixed(2) : null,
    };
    if (r.tier === "judge") {
      row.tier = "judge";
      row.judge = judge;                // candidates / judged / tally / model
    }
    if (r.judgedBy) row.judgedBy = r.judgedBy;
    out.push(row);
  }
  return { total, at: cache ? cache.at : null, rules: out };
}

/** Weighted penalty. Unmeasured rules are excluded from the denominator rather
 *  than counted as zero - a check that never ran is not a check that passed. */
function score(rules) {
  const measured = rules.filter((r) => r.measured);
  if (!measured.length) return { score: null, measured: 0, of: rules.length };
  let penalty = 0, maxPenalty = 0;
  for (const r of measured) {
    penalty += r.weight * (r.pct / 100);
    maxPenalty += r.weight;
  }
  const s = Math.max(0, Math.round(100 - (penalty / maxPenalty) * 100 * (maxPenalty / 20)));
  return { score: Math.min(100, s), measured: measured.length, of: rules.length };
}

module.exports = { RULES, byId, materialize, readCache, counts, score, cifKey, cifChecksumOk, CACHE };
