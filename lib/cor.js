"use strict";
/**
 * COR (Clasificarea Ocupatiilor din Romania) matcher - maps a free-text job
 * title to an official occupation code, the same way lib/locations.js maps a
 * free-text location to an official SIRUTA name.
 *
 * PROVENANCE (lib/cor.json)
 * --------------------------------------------------------------------------
 * Source: data.gov.ro, dataset "Clasificarea Ocupatiilor din Romania"
 *   https://data.gov.ro/dataset/695974d3-4be3-4bbe-a56a-bb639ad908e2
 * Files downloaded directly (both HTTP 200, served by the Ministry's own
 * open-data portal, OGL-ROU-1.0 licence):
 *   - isco-08-lista-cresc-cod-ocupatii-cor-2024.xml  (codes, increasing order)
 *   - cor-grupe-ocupationale.xml  (1/2/3/4-digit group labels, for majorLabel)
 * Both files are Microsoft "Flat OPC" XML exports of a Word table / Excel
 * sheet (not CSV/JSON) - they were parsed with a small one-off script that
 * pulled the <w:t>/<Data> text runs out of each table row.
 *
 * COMPLETENESS: this is the FULL official 2024 COR list, not a curated
 * subset - 4,422 six-digit occupation codes with Romanian names. The
 * Ministry's own document actually contains 4,537 numbered rows; 115 of
 * those have a code but an EMPTY name cell in the ministry's own table.
 * Those 115 rows were dropped rather than invented.
 *
 * =========================================================================
 * MATCHING STRATEGY - seven ordered tiers, most-confident first
 * =========================================================================
 * Every tier is individually switchable (see STAGES / matchTitle opts), so
 * tools/cor_bench.js can report exactly what each one buys. Measured on the
 * real index (58,684 jobs / 29,567 distinct titles) - see ANALIZA-AI.md.
 *
 *   0. normalise   - HTML entities decoded, emoji/salary/gender-marker/
 *                    parenthetical/ad-boilerplate noise stripped, diacritics
 *                    folded, seniority and locality affixes removed.
 *   1. exact       - the whole cleaned title equals a COR name.
 *   2. synonym     - hand-written phrase table (incl. English -> Romanian),
 *                    whole-word, longest phrase first.
 *   3. phrase      - a COR name of >= 2 content words occurs as a CONTIGUOUS
 *                    whole-word phrase inside the title. Longest wins.
 *   4. subset      - a COR name's content words are all present in the title,
 *                    IN THE SAME ORDER (gaps allowed). Longest wins.
 *   5. segment     - the title is split on / | , - and each segment is run
 *                    back through tiers 1-4. "Montator / Electromecanic".
 *   6. fuzzy       - bounded Levenshtein, same guard rails as locations.js.
 *
 * WHY ORDER-PRESERVING SUBSET, AND NOT PLAIN BAG-OF-WORDS
 * --------------------------------------------------------------------------
 * A bag-of-words subset happily matches "operator" + "instalatii" scattered
 * across an unrelated 12-word ad. Requiring the COR words to appear in the
 * title in their COR order costs nothing and removes most of that class of
 * false positive. On top of it, three refusals are absolute:
 *   - a COR name of a single content word never matches by subset/phrase
 *     (that is what the curated synonym table is for);
 *   - two different codes tying at the same specificity -> refuse, never pick;
 *   - a title shorter than the COR name it would match -> impossible, refuse.
 *
 * GUARDED SINGULAR/PLURAL FOLDING
 * --------------------------------------------------------------------------
 * Romanian plurals are irregular enough that a general stemmer invents words.
 * Instead, normToken() only ever rewrites a title word onto a word that
 * ALREADY EXISTS in the COR vocabulary: "operatori" -> "operator" is accepted
 * because "operator" is a COR word; "olanda" -> "oland" is rejected because
 * "oland" is not. The stemmer therefore cannot manufacture a token, which is
 * the failure mode that has burned this project before.
 *
 * DELIBERATE REFUSALS
 * --------------------------------------------------------------------------
 * A handful of very common Romanian job-board terms have NO single COR code -
 * the official nomenclature only defines them per-sector. Inventing a
 * "generic" mapping would silently corrupt the classification:
 *   - "muncitor necalificat" (bare)   - COR only has ~12 sector-specific codes
 *   - "operator productie" (bare)     - COR only has machine/sector-specific
 *                                       operator codes (siloz, portuar, RTV)
 *   - "inginer" (bare)                - COR has ~350 engineer codes
 * These are enforced by REFUSE_BARE below: even if a later tier finds a
 * candidate, a title that reduces to exactly one of these phrases is refused.
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// text normalisation - same diacritic folding convention as lib/locations.js
// ---------------------------------------------------------------------------
const DIA = { "ă": "a", "â": "a", "î": "i", "ș": "s", "ț": "t", "ş": "s", "ţ": "t",
  "Ă": "a", "Â": "a", "Î": "i", "Ș": "s", "Ț": "t", "Ş": "s", "Ţ": "t" };
const stripDia = (s) => String(s).replace(/[ăâîșțşţĂÂÎȘȚŞŢ]/g, (c) => DIA[c] || c);

/** lowercase, diacritics folded, non-alnum collapsed to single spaces, trimmed - word structure kept */
const foldKey = (s) => stripDia(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
/** foldKey with the spaces removed too - for exact whole-name comparisons */
const denseKey = (s) => foldKey(s).replace(/ /g, "");

// ---------------------------------------------------------------------------
// STAGE 0a - HTML entities
// ---------------------------------------------------------------------------
const NAMED_ENT = {
  amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ",
  ndash: "-", mdash: "-", hellip: "...", sbquo: ",", laquo: '"', raquo: '"',
  ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'", bull: " ", middot: " ",
};
/** Decode HTML entities, twice, because scrapers double-encode ("&amp;amp;"). */
function decodeEntities(s) {
  let out = String(s);
  for (let pass = 0; pass < 2; pass++) {
    const before = out;
    out = out.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body) => {
      if (body[0] === "#") {
        const code = body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      const k = body.toLowerCase();
      return k in NAMED_ENT ? NAMED_ENT[k] : m;
    });
    if (out === before) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// STAGE 0b - strip recruitment/ad noise
// ---------------------------------------------------------------------------

// Romanian job-ad boilerplate: calls to action, urgency markers, filler.
// The list as it shipped on 2026-08-20 ...
const AD_NOISE_V1 = [
  "angajam", "angajez", "angajeaza", "angajare", "angajari", "angajat", "angajati",
  "recrutam", "recrutare", "cautam", "caut", "cauta", "cautari",
  "oferim", "oferta", "ofertam", "avem nevoie de", "avem nevoie",
  "urgent", "urgenta", "imediat", "disponibil imediat",
  "post vacant", "posturi vacante", "loc de munca", "locuri de munca",
  "full time", "part time", "fulltime", "parttime",
  "norma intreaga", "norma redusa", "program flexibil",
  "cu experienta", "fara experienta", "cu sau fara experienta",
  "salariu atractiv", "salariu motivant", "bonusuri", "tichete de masa",
  "carte de munca", "contract de munca", "colaborare pfa", "colaborare srl",
];

// ... and everything the measured residue added on top of it. Every phrase
// here was read off a real unmatched title in tools/cor_bench.js output.
const AD_NOISE_V2 = [
  "angajeza", "se angajeaza", "se cauta", "se recruteaza", "recrutez",
  "cautati un job", "urgente", "incepere imediata",
  "post disponibil", "posturi disponibile",
  "job", "joburi", "oportunitate", "oportunitati",
  "full timp", "jumatate de norma", "program fix", "in ture", "ture",
  "experienta", "salariu", "bonus", "tichete",
  "cazare si masa", "cazare", "masa", "transport asigurat", "pfa",
  "barbati si femei", "femei si barbati", "barbati femei", "femei barbati",
  "barbati", "femei", "baieti", "fete", "doamne", "domni",
  "cu relocare", "relocare", "plecare in", "plecare",
  "incepatori", "incepator", "debutant", "debutanti",
  "anunt", "anunturi", "companie", "firma", "fabrica de", "fabrica",
  "societate comerciala", "multinationala",
  "se ofera", "beneficii", "aplica acum", "aplica", "trimite cv", "cv",
];

const noiseRe = (words) => new RegExp(
  "\\b(" + words
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"))
    .join("|") + ")\\b",
  "gi"
);
const AD_NOISE_V1_RE = noiseRe(AD_NOISE_V1);
const AD_NOISE_V2_RE = noiseRe([...AD_NOISE_V1, ...AD_NOISE_V2]);

// gender-marker / grade suffixes, and any other parenthetical aside:
// "(m/f/x)", "(plecare in Olanda)", "(produse alimentare)". Titles use
// parentheses for asides; COR names that use them are matched on their
// paren-free form too, so dropping them is symmetric.
const PARENS_RE = /\([^)]{0,80}\)|\[[^\]]{0,80}\]/g;
// what the 2026-08-20 module stripped instead: only the gender marker
const GENDER_MARKER_RE = /\((?:\s*[mfx]\s*\/\s*[mfx]\s*(?:\/\s*[mfx]\s*)?)\)/gi;

// seniority/grade band words - noise for occupation classification (a
// "Senior Java Developer" and a "Java Developer" are the same COR occupation)
// NOTE what is deliberately NOT in here. "expert" appears in 95 official COR
// names, "specialist" in 80, "principal" in 5, "mediu" in 8 - stripping those
// as seniority noise destroys real occupations ("SPECIALIST IN ACHIZITII" is
// COR 332301). Only bands that never occur in a COR name are removed.
const SENIORITY_RE = /\b(junior|jr|senior|sr|medior|entry[- ]?level|trainee|stagiar|stagiu|internship|associate)\b/gi;
// the 2026-08-20 version, kept only so tools/cor_bench.js can rebuild the old
// baseline. It also ate "expert", "specialist", "principal" and "mediu" -
// which is exactly why "SPECIALIST IN ACHIZITII" (COR 332301) used to come
// back unmatched.
const SENIORITY_V1_RE = /\b(junior|senior|mediu|medior|entry[- ]?level|entry|principal|lead|staff|trainee|stagiar|stagiu|intern|internship|associate|asociat)\b/gi;

// salary fragments: "200 euro/saptamana", "3000 lei / luna", "15 lei/ora", "de la 3000 lei"
const SALARY_RE = /\b\d{2,6}\s*(?:lei|ron|euro|eur|\$|usd)\b(?:\s*\/\s*\p{L}+)?/giu;

// emoji and pictographs
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

// runs of punctuation noise: "!!!", "***", "---", "|"
const PUNCT_NOISE_RE = /[!*~_|]{2,}|[-–—]{2,}/g;

// county-seat + capital locality names that commonly ride along in job titles
// ("Sofer Ploiesti", "Agenti Securitate Sector 3"). Extended at load time from
// siruta_index.json when that file is present - see localityNoise().
const LOCALITY_NOISE = [
  "bucuresti", "bucurestiul", "sector 1", "sector 2", "sector 3", "sector 4", "sector 5", "sector 6",
  "alba iulia", "arad", "pitesti", "bacau", "oradea", "bistrita", "botosani", "braila", "brasov",
  "buzau", "resita", "calarasi", "cluj napoca", "cluj", "constanta", "sfantu gheorghe", "targoviste",
  "craiova", "galati", "giurgiu", "targu jiu", "miercurea ciuc", "deva", "slobozia", "iasi",
  "baia mare", "drobeta turnu severin", "targu mures", "piatra neamt", "slatina", "ploiesti",
  "satu mare", "zalau", "sibiu", "suceava", "alexandria", "timisoara", "tulcea", "vaslui",
  "ramnicu valcea", "focsani", "voluntari", "otopeni",
];

// Destination markers on placement ads: "MECANIC camioane (plecare in
// Olanda)", "ROUTIER cauta colaboratori tractionisti comunitate Venlo".
// A v2 addition - the 2026-08-20 list had no countries in it.
const COUNTRY_NOISE = [
  "olanda", "germania", "belgia", "austria", "italia", "spania", "franta", "anglia",
  "marea britanie", "danemarca", "norvegia", "polonia", "ungaria", "cehia", "romania",
];

function buildLocalityRe(extra) {
  const all = [...new Set([...LOCALITY_NOISE, ...(extra || [])])]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"));
  return new RegExp("\\b(" + all.join("|") + ")\\b", "gi");
}

/**
 * Extra single-word locality names, read from the SIRUTA index if it happens
 * to be present. SOFT dependency: cor.js keeps working without it.
 * Guarded by `corVocab` - a place name that is also a COR occupation word
 * (there is at least one: "Cristian") is never treated as noise.
 */
function localityNoise(root, corVocab) {
  const p = path.join(root, "siruta_index.json");
  if (!fs.existsSync(p)) return [];
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return []; }
  const out = [];
  for (const v of Object.values(raw)) {
    const f = foldKey(v && v.name);
    if (!f || f.includes(" ")) continue;      // single-word names only
    if (f.length < 5) continue;               // too short - would eat real words
    if (corVocab.has(f)) continue;            // it is also an occupation word
    out.push(f);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// stop words - grammatical glue that carries no occupation meaning.
// Removed from BOTH the title and the COR name before token comparison, so
// "agent vanzari" can meet "agent de vanzari".
// ---------------------------------------------------------------------------
const STOP = new Set([
  "de", "la", "in", "si", "pe", "cu", "pentru", "a", "al", "ale", "ai", "din", "sau",
  "prin", "sub", "spre", "ca", "care", "un", "o", "unui", "unei", "cel", "cea",
  "the", "of", "and", "for", "to", "with", "at", "on", "in",
]);

/**
 * Phrases refused outright, because COR has no generic code for them and every
 * candidate the tiers below would offer is a DIFFERENT, sector-specific
 * occupation. Each line was checked against lib/cor.json before being added:
 *
 *   muncitor necalificat  -> ~12 sector codes (agricultura, constructii, mine...)
 *   operator productie    -> only machine/sector operators (siloz, portuar, RTV)
 *   inginer               -> ~350 discipline-specific engineer codes
 *   instalator            -> 16 codes, all "instalator <ce anume>"
 *   economist             -> 24 codes, all "economist in <domeniu>"
 *   secretar              -> 51 codes, all institution-specific
 *   vulcanizator          -> only rubber-industry codes; the Romanian job-board
 *                            sense (tyre fitter) is simply not in COR
 *   livrator, picker-less English management titles (project manager, key
 *   account manager, devops, scrum master, product owner, call center) ->
 *                            no COR entry exists at all, in any spelling.
 */
const REFUSE_BARE = new Set([
  "muncitor necalificat", "muncitori necalificati", "necalificat", "necalificati",
  "operator productie", "operatori productie", "operator", "operatori",
  "inginer", "ingineri", "tehnician", "tehnicieni",
  "manager", "consultant", "consilier", "asistent", "agent", "reprezentant",
  "lucrator", "lucratori", "personal", "muncitor", "muncitori", "colaborator",
  "instalator", "instalatori", "economist", "economisti",
  "secretar", "secretara", "vulcanizator", "vulcanizatori",
  "livrator", "livratori", "montator", "montatori",
  "project manager", "manager de proiect", "manager proiect",
  "key account manager", "account manager", "sales manager", "manager vanzari",
  "devops engineer", "devops", "scrum master", "product owner", "product manager",
  "call center", "operator call center", "agent call center", "customer support",
  "consilier vanzari", "consultant vanzari",
  "mecanic mentenanta", "tehnician mentenanta", "maintenance technician",
]);

// ---------------------------------------------------------------------------
// STAGE 2 - hand-written synonym table
// Each group: { code, phrases: [...] }. Phrases are folded before comparison,
// so write them in plain lowercase ASCII. Matched longest-phrase-first.
//
// The English -> Romanian half of this table was NOT invented: every entry
// below was taken from the measured residue of tools/cor_bench.js, i.e. from
// titles that really occur in this index. Frequencies quoted in the comments
// are job counts from the 58,684-doc snapshot.
// ---------------------------------------------------------------------------
const SYNONYM_GROUPS = [
  // --- transport / soferi -----------------------------------------------
  { code: "833101", phrases: ["sofer autobuz", "sofer microbuz", "sofer transport persoane", "conducator auto transport persoane", "sofer maxi taxi", "sofer autocar", "bus driver"] },
  { code: "833102", phrases: ["sofer troleibuz", "conducator troleibuz"] },
  { code: "833103", phrases: ["sofer tramvai", "vatman"] },
  { code: "832203", phrases: ["sofer ambulanta", "sofer autoambulanta"] },
  { code: "832201", phrases: ["sofer autoturisme", "sofer personal", "sofer masina de serviciu"] },
  { code: "833205", phrases: ["camionagiu"] },
  {
    code: "833201",
    phrases: [
      "sofer", "soferi", "soferita", "sofereasa",
      "conducator auto", "conducatori auto", "conducator auto marfa", "conducator auto marfuri",
      "driver", "drivers", "truck driver", "hgv driver", "lkw fahrer",
      "sofer categoria ce", "sofer categoria c e", "sofer cat ce", "sofer cat c e", "sofer c e",
      "sofer categoria c", "sofer cat c",
      "tir", "sofer tir", "sofer international", "transport international marfa",
      "camion", "sofer camion", "sofer de mare tonaj", "masina de mare tonaj",
      "tractionist", "tractionisti",
    ],
  },

  // --- vanzari -------------------------------------------------------------
  { code: "522101", phrases: ["vanzatori", "vanzatoare", "vanzatoarea", "shop assistant", "sales assistant"] },
  { code: "522303", phrases: ["lucratori comerciali", "lucrator in comert"] },
  // COR 332203 "agent de vânzări" - the generic field sales rep. The residue
  // spells the same role five other ways.
  { code: "332203", phrases: ["agent vanzari", "agenti vanzari", "reprezentant vanzari", "reprezentanti vanzari", "sales representative", "sales agent", "reprezentant comercial", "agent comercial"] },

  // --- HoReCa ----------------------------------------------------------
  { code: "512001", phrases: ["bucatari", "bucataras", "bucatareasa", "cook", "chef de partie"] },
  { code: "941101", phrases: ["ajutor de bucatar", "ajutori bucatar", "ajutor bucatar", "kitchen helper"] },
  { code: "513102", phrases: ["ospatari", "chelner", "chelneri", "chelnerita", "chelnerite", "ospatarita", "waiter", "waitress"] },
  { code: "513201", phrases: ["barmani", "bartender", "barmanita"] },
  { code: "941201", phrases: ["spalator vase", "spalatori vase", "dishwasher"] },   // COR: "lucrător bucătărie (spălător vase mari)"

  // --- logistica ---------------------------------------------------------
  { code: "834403", phrases: ["stivuitoristi", "operator stivuitor", "forklift operator", "forklift driver"] },
  {
    // COR 933303 "manipulant mărfuri". "Picker" has no English entry anywhere in
    // COR; the Romanian occupation an order picker performs IS unskilled
    // warehouse goods handling, so it lands here. This is the one judgement
    // call in the table - flagged in ANALIZA-AI.md rather than hidden.
    code: "933303",
    phrases: [
      "manipulant marfa", "manipulanti marfa", "manipulanti marfuri", "manipulare marfa",
      "personal depozit", "manipulant depozit", "manipulanti depozit",
      "lucrator depozit", "lucratori depozit", "warehouse worker", "warehouse operative",
      "picker", "pickeri", "order picker", "picker depozit",
    ],
  },
  { code: "932101", phrases: ["ambalator", "ambalatori", "ambalatori manuali", "packer", "packers"] },
  { code: "432102", phrases: ["magazineri", "warehouse keeper"] },
  { code: "432101", phrases: ["gestionar depozit"] },
  { code: "132444", phrases: ["sef depozit", "warehouse manager"] },

  // --- paza ----------------------------------------------------------------
  {
    code: "541401",
    phrases: [
      "agent paza", "agenti paza", "agent de paza", "agenti de paza",
      "agent securitate", "agenti securitate", "agenti de securitate",
      "security guard", "security officer",
    ],
  },

  // --- curatenie -----------------------------------------------------------
  {
    code: "911201",
    phrases: [
      "femei de serviciu", "femeia de serviciu", "om de serviciu", "oameni de serviciu",
      "personal curatenie", "personal de curatenie", "cleaner", "ingrijitoare curatenie",
      "personal de serviciu", "lucrator curatenie",
    ],
  },
  { code: "515302", phrases: ["agenti de curatenie", "agent de curatenie", "agent curatenie birouri"] },

  // --- sanatate --------------------------------------------------------
  { code: "222101", phrases: ["asistenti medicali", "asistenta medicala", "asistent medical", "nurse", "registered nurse"] },
  { code: "532103", phrases: ["infirmier", "infirmiere", "infirmieri"] },   // COR: "infirmier/infirmieră"
  { code: "532201", phrases: ["ingrijitor batrani", "ingrijitoare batrani", "ingrijitor la domiciliu", "badanta", "badante"] },

  // --- IT --------------------------------------------------------------
  { code: "251202", phrases: ["programatori", "coder"] },
  {
    code: "251105",   // COR "dezvoltator de sisteme în domeniul TIC"
    phrases: [
      "dezvoltator software", "dezvoltator", "developer", "software developer",
      "full stack developer", "fullstack developer", "web developer", "backend developer",
      "frontend developer", "front end developer", "back end developer",
      "software engineer", "java developer", "net developer", "python developer",
      "react developer", "angular developer", "php developer",
      "mobile developer", "android developer", "ios developer", "embedded software engineer",
    ],
  },
  { code: "351108", phrases: ["qa engineer", "test engineer", "software tester", "tester", "qa automation engineer", "analist testare"] },  // COR "analist testare software"
  { code: "252101", phrases: ["database administrator", "dba"] },
  { code: "252301", phrases: ["network administrator", "administrator retea", "administrator retea de calculatoare"] },
  { code: "251201", phrases: ["business analyst", "analist de business", "analist business"] },   // COR 251201 "analist" (grupa TIC)
  { code: "251203", phrases: ["system engineer", "inginer de sistem"] },

  // --- financiar -------------------------------------------------------
  { code: "331302", phrases: ["contabili", "contabila", "bookkeeper", "accountant", "general ledger accountant", "accounts payable accountant", "accounts receivable accountant", "contabil primar"] },
  { code: "241102", phrases: ["expert contabil"] },
  { code: "241305", phrases: ["financial analyst"] },      // COR "analist financiar"

  // --- HR / birou ------------------------------------------------------
  { code: "242314", phrases: ["hr specialist", "hr generalist", "hr officer", "recruiter", "recrutor", "talent acquisition specialist"] },
  { code: "334303", phrases: ["asistent manager", "asistenta manager", "office assistant"] },
  { code: "422601", phrases: ["receptionist", "receptioner"] },
  { code: "333912", phrases: ["telesales", "operator telesales", "agent telesales"] },   // COR "operator vânzări prin telefon"

  // --- constructii / meserii -------------------------------------------
  // JUDGEMENT CALL, inherited from the 2026-08-20 table and kept: COR has 39
  // "electrician <ceva>" codes and no generic one, but a Romanian ad that says
  // only "Electrician" means maintenance electrician in practice.
  { code: "741307", phrases: ["electrician", "electricieni", "electrician intretinere"] },
  { code: "721410", phrases: ["lacatus", "lacatusi", "lacatus mecanic"] },
  { code: "711205", phrases: ["zidar", "zidari", "zidar rosar tencuitor"] },
  { code: "711501", phrases: ["dulgheri"] },
  { code: "721208", phrases: ["sudori", "welder"] },
  { code: "713102", phrases: ["zugravi", "painter"] },
  { code: "711402", phrases: ["fierari betonisti"] },
  // COR 132308 "șef șantier". "M&E Site Manager" (428 jobs, the single largest
  // unmatched title in the index) is a Mechanical & Electrical site manager.
  { code: "132308", phrases: ["site manager", "sef de santier", "m e site manager", "construction manager"] },
  // COR 722323 "operator la mașini-unelte cu comandă numerică" - the official
  // name for a CNC operator. The string "CNC" appears nowhere in COR.
  { code: "722323", phrases: ["operator cnc", "operatori cnc", "operator masini cnc", "cnc operator", "cnc machinist", "operator masini unelte cnc"] },
  { code: "723103", phrases: ["mecanici auto", "mecanic auto intretinere", "auto mechanic", "mecanic camioane", "mecanic camion"] },
  { code: "723101", phrases: ["electrician auto"] },
  // COR spells the un-specialised machinist trades "<meserie> universal"
  { code: "722408", phrases: ["frezor", "frezori"] },
  { code: "722413", phrases: ["strungar", "strungari"] },
  { code: "752201", phrases: ["tamplar", "tamplari"] },

  // --- diverse -----------------------------------------------------------
  { code: "962101", phrases: ["curieri", "courier"] },
  { code: "523003", phrases: ["casieri", "casiera", "cashier"] },
  { code: "751103", phrases: ["macelari", "butcher"] },
  { code: "751201", phrases: ["brutari", "baker"] },
  { code: "753101", phrases: ["croitori", "croitoreasa", "tailor"] },
  { code: "333401", phrases: ["agent imobiliar", "agenti imobiliari", "real estate agent"] },
];

// ---------------------------------------------------------------------------
// STAGE FLAGS - every tier can be switched off, so the bench can price it
// ---------------------------------------------------------------------------
const STAGES = {
  entities: true,   // 0a  decode HTML entities
  diacritics: true, // 0b  fold diacritics
  noise: true,      // 0c  the 2026-08-20 cleaning: ad boilerplate, gender marker, seniority, county seats
  noise2: true,     // 0c' the additions measured off the residue: full parens, countries, all 10,263
                    //     SIRUTA localities, the wider ad list, and the corrected seniority list
  plural: true,     // 0d  guarded singular/plural folding onto the COR vocabulary
  exact: true,      // 1
  synonym: true,    // 2
  phrase: true,     // 3
  subset: true,     // 4
  segment: true,    // 5
  fuzzy: true,      // 6
};
const stagesWith = (opts) => (opts && opts.stages ? { ...STAGES, ...opts.stages } : STAGES);

// ---------------------------------------------------------------------------
// cleaning
// ---------------------------------------------------------------------------
/**
 * cleanTitle(raw, index, stages) -> folded, space-separated, noise-free string.
 * `index` is optional; without it the locality list is the built-in one.
 */
function cleanTitle(raw, index, st) {
  st = st || STAGES;
  if (raw === undefined || raw === null) return "";
  let s = String(raw);
  if (st.entities) s = decodeEntities(s);
  s = s.replace(EMOJI_RE, " ");
  if (st.noise) s = s.replace(st.noise2 ? PARENS_RE : GENDER_MARKER_RE, " ");
  s = s.replace(SALARY_RE, " ");
  s = s.replace(PUNCT_NOISE_RE, " ");
  // fold to a plain, space-separated word string before word-boundary passes
  s = st.diacritics ? foldKey(s) : String(s).toLowerCase().replace(/[^a-z0-9ăâîșțşţ]+/g, " ").trim();
  if (!s) return "";
  if (st.noise) {
    s = s.replace(st.noise2 ? AD_NOISE_V2_RE : AD_NOISE_V1_RE, " ");
    s = s.replace(st.noise2 ? SENIORITY_RE : SENIORITY_V1_RE, " ");
    s = s.replace(
      st.noise2
        ? ((index && index.localityRe) || buildLocalityRe(COUNTRY_NOISE))
        : buildLocalityRe([]),
      " "
    );
  }
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// ---------------------------------------------------------------------------
// guarded singular/plural folding
// ---------------------------------------------------------------------------
/**
 * Rewrite one title word onto a word that already exists in the COR
 * vocabulary, or leave it alone. Never produces a word COR does not contain.
 */
function normToken(w, vocab) {
  if (!vocab || vocab.has(w)) return w;
  if (w.length < 4) return w;
  const tries = [];
  if (w.endsWith("ii")) tries.push(w.slice(0, -1), w.slice(0, -2) + "ie");
  if (w.endsWith("i")) tries.push(w.slice(0, -1), w.slice(0, -1) + "e", w.slice(0, -1) + "a");
  if (w.endsWith("uri")) tries.push(w.slice(0, -3));
  if (w.endsWith("ori")) tries.push(w.slice(0, -3) + "or");
  if (w.endsWith("ari")) tries.push(w.slice(0, -3) + "ar");
  if (w.endsWith("oare")) tries.push(w.slice(0, -4) + "or");
  if (w.endsWith("toare")) tries.push(w.slice(0, -5) + "tor");
  if (w.endsWith("e")) tries.push(w.slice(0, -1), w.slice(0, -1) + "a");
  if (w.endsWith("le")) tries.push(w.slice(0, -2));
  if (w.endsWith("a")) tries.push(w.slice(0, -1));
  if (w.endsWith("ul")) tries.push(w.slice(0, -2));
  if (w.endsWith("ului")) tries.push(w.slice(0, -4));
  for (const t of tries) if (t.length >= 3 && vocab.has(t)) return t;
  return w;
}

/** content tokens of a folded string: stop words dropped, plurals folded */
function contentTokens(folded, vocab, usePlural) {
  const out = [];
  for (const w of String(folded).split(" ")) {
    if (!w || STOP.has(w)) continue;
    out.push(usePlural === false ? w : normToken(w, vocab));
  }
  return out;
}

// ---------------------------------------------------------------------------
// loadCor - build the matching index from lib/cor.json
// ---------------------------------------------------------------------------
/**
 * loadCor(dir, opts)
 *   opts.synonymGroups - override the synonym table (tools/cor_bench.js passes
 *                        the 2026-08-20 table to reproduce the old baseline)
 *   opts.noAlias       - skip the paren-derived alias index
 */
function loadCor(dir, opts) {
  opts = opts || {};
  const base = dir || __dirname;
  const root = path.join(base, "..");
  const p = path.join(base, "cor.json");
  const list = JSON.parse(fs.readFileSync(p, "utf8"));

  const byCode = new Map();
  const byDense = new Map(); // denseKey(name) -> occupation, or "AMBIGUOUS"
  const buckets = new Map(); // denseKey length -> [{dense, code}]
  const vocab = new Set();   // every content word that appears in a COR name

  // pass 1: vocabulary (needed before plural folding can be guarded)
  for (const occ of list) {
    for (const w of foldKey(occ.name).split(" ")) if (w && !STOP.has(w)) vocab.add(w);
  }

  // pass 2: the actual indexes
  //
  // Every occupation is indexed under BOTH spellings the official list uses:
  // the full name, and the name with its parenthetical gloss removed. 217 COR
  // names carry a gloss - "ospătar (chelner)", "dulgher (exclusiv
  // restaurator)", "conducător tramvai (vatman)" - and the index spells the
  // same job both ways, so both must resolve. An alias is only registered when
  // it does not collide with a different code.
  const entries = [];        // { code, toks }
  const byAlias = new Map(); // paren-derived spellings, LOWER priority than byDense
  const mk = (map) => (d, occ) => {
    if (!d) return;
    if (map.has(d) && map.get(d) !== "AMBIGUOUS" && map.get(d).code !== occ.code) {
      map.set(d, "AMBIGUOUS"); // two different official codes share a name - never guess
    } else if (!map.has(d)) {
      map.set(d, occ);
    }
  };
  const addDense = mk(byDense);
  const addAlias = mk(byAlias);
  const seenEntry = new Set();

  // pass 2a: official names, verbatim
  for (const occ of list) {
    byCode.set(occ.code, occ);
    const d = denseKey(occ.name);
    if (!d) continue;
    addDense(d, occ);
    if (!buckets.has(d.length)) buckets.set(d.length, []);
    buckets.get(d.length).push({ dense: d, code: occ.code });
    const toks = contentTokens(foldKey(occ.name), vocab, true);
    const sig = occ.code + "|" + toks.join(" ");
    if (toks.length >= 2) { seenEntry.add(sig); entries.push({ code: occ.code, toks }); }
  }

  // pass 2b: aliases from the parenthetical gloss 207 COR names carry.
  // "ospătar (chelner)" is spelled three ways in the wild - with the gloss,
  // without it, and as the gloss alone - and all three mean 513102. Aliases
  // live in their own map so a verbatim official name always outranks them,
  // and a collision between two aliases is marked AMBIGUOUS, not guessed.
  for (const occ of opts.noAlias ? [] : list) {
    const noParen = occ.name.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    const inParen = ((occ.name.match(/\(([^)]*)\)/) || [])[1] || "").trim();
    const forms = [];
    if (noParen && noParen !== occ.name) forms.push(noParen);
    // a gloss that only qualifies the entry ("exclusiv X", "studii medii") is
    // not another name for the job, so it never becomes an alias of its own
    if (inParen && !/^(exclusiv|inclusiv|studii)\b/i.test(inParen)) forms.push(inParen);
    for (const form of forms) {
      const d = denseKey(form);
      if (!d || byDense.has(d)) continue;
      addAlias(d, occ);
      const toks = contentTokens(foldKey(form), vocab, true);
      const sig = occ.code + "|" + toks.join(" ");
      if (toks.length >= 2 && !seenEntry.has(sig)) {
        seenEntry.add(sig);
        entries.push({ code: occ.code, toks });
      }
    }
  }

  // inverted index token -> entry ids, for the phrase/subset tiers
  const postings = new Map();
  entries.forEach((e, i) => {
    for (const t of new Set(e.toks)) {
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push(i);
    }
  });

  // pre-fold synonym phrases, longest-phrase-first
  const synonyms = [];
  for (const group of (opts.synonymGroups || SYNONYM_GROUPS)) {
    if (!byCode.has(group.code)) continue; // defensive: code must exist in the loaded list
    for (const phrase of group.phrases) {
      const folded = foldKey(phrase);
      if (!folded) continue;
      synonyms.push({ code: group.code, folded, words: folded.split(" ").length });
    }
  }
  synonyms.sort((a, b) => b.words - a.words || b.folded.length - a.folded.length);

  const localityRe = buildLocalityRe([...COUNTRY_NOISE, ...localityNoise(root, vocab)]);

  return { list, byCode, byDense, byAlias, buckets, synonyms, vocab, entries, postings, localityRe };
}

// ---------------------------------------------------------------------------
// Levenshtein, bounded - identical shape to lib/locations.js's `lev`
// ---------------------------------------------------------------------------
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Conservative fuzzy match: a wrong "correction" is worse than no match. */
function fuzzyMatch(dense, index) {
  if (dense.length < 8) return null; // occupation names are longer than place names; be stricter
  const max = dense.length <= 12 ? 1 : 2;
  const MAX_RATIO = 0.12;

  let best = null, bestD = max + 1, ties = 0;
  for (let len = dense.length - max; len <= dense.length + max; len++) {
    for (const cand of index.buckets.get(len) || []) {
      if (cand.dense[0] !== dense[0]) continue; // first letter must hold
      const d = lev(dense, cand.dense, max);
      if (d > max) continue;
      if (d < bestD) { bestD = d; best = cand; ties = 1; }
      else if (d === bestD && cand.code !== best.code) ties++;
    }
  }
  if (!best || bestD > max) return null;
  if (ties > 1) return null; // ambiguous -> refuse to guess
  if (bestD / Math.max(dense.length, best.dense.length) > MAX_RATIO) return null;
  return { code: best.code, dist: bestD };
}

// ---------------------------------------------------------------------------
// phrase / subset tiers
// ---------------------------------------------------------------------------
/** entry ids worth testing against this token list */
function candidateEntries(toks, index) {
  const seen = new Set();
  for (const t of new Set(toks)) {
    const list = index.postings.get(t);
    if (!list) continue;
    for (const i of list) seen.add(i);
  }
  return seen;
}

/**
 * true when `sub` appears inside `toks` in order, within a TIGHT window.
 *
 * The window is what stops the tier inventing matches. Without it, a hand-check
 * of 25 real subset hits produced these false positives, all the same shape -
 * the COR words were harvested from opposite ends of an unrelated title:
 *   "Manager Departament Logistica - Zona Metropolitana Timisoara"
 *        -> 142008 "manager de zona"      (manager@0, zona@7)
 *   "Asistent suport administrativ & social media"
 *        -> 263501 "asistent social"      (asistent@0, social@4)
 *   "Angajam reglor mecanic-fabrica de arcuri auto"
 *        -> 723103 "mecanic auto"         (mecanic@1, auto@5)
 * Allowing at most MAX_GAP filler words inside the span kills all three and
 * keeps the legitimate ones ("Consilier Vanzari Directe Asigurari de Persoane"
 * -> 241245 "consilier vanzari asigurari", one filler word inside the span).
 */
const MAX_GAP = 2;
function orderedSubset(sub, toks) {
  // earliest match is not necessarily the tightest, so try every start
  for (let s = 0; s < toks.length; s++) {
    if (toks[s] !== sub[0]) continue;
    let i = 1, end = s;
    for (let j = s + 1; j < toks.length && i < sub.length; j++) {
      if (toks[j] === sub[i]) { i++; end = j; }
    }
    if (i === sub.length && (end - s + 1) - sub.length <= MAX_GAP) return true;
  }
  return false;
}

/** true when `sub` appears inside `toks` contiguously */
function contiguous(sub, toks) {
  outer: for (let i = 0; i + sub.length <= toks.length; i++) {
    for (let j = 0; j < sub.length; j++) if (toks[i + j] !== sub[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Best COR entry whose tokens sit inside `toks`.
 * `mode` = "phrase" (contiguous) or "subset" (in order, gaps allowed).
 * Longest (most content words) wins; a tie between two DIFFERENT codes is
 * refused rather than guessed.
 */
function bestContained(toks, index, mode) {
  if (toks.length < 2) return null;
  const test = mode === "phrase" ? contiguous : orderedSubset;
  // A two-word COR name matched with gaps is the false-positive generator:
  // "manager de zona" out of "Manager Departament Logistica - Zona
  // Metropolitana", "asistent social" out of "Asistent suport administrativ &
  // social media", "mecanic auto" out of "reglor mecanic ... arcuri auto".
  // Two-word names must therefore be CONTIGUOUS (the phrase tier); the gapped
  // tier only accepts names of three content words or more.
  const minWords = mode === "phrase" ? 2 : 3;
  let best = null, bestLen = 0, tie = false;
  for (const i of candidateEntries(toks, index)) {
    const e = index.entries[i];
    if (e.toks.length < minWords || e.toks.length > toks.length) continue;
    if (e.toks.length < bestLen) continue;
    if (!test(e.toks, toks)) continue;
    if (e.toks.length > bestLen) { best = e; bestLen = e.toks.length; tie = false; }
    else if (best && e.code !== best.code) tie = true;
  }
  if (!best || tie) return null;
  return { code: best.code, words: bestLen, coverage: bestLen / toks.length };
}

// ---------------------------------------------------------------------------
// matchTitle
// ---------------------------------------------------------------------------
const hit = (index, code, how, score, extra) => {
  const occ = index.byCode.get(code);
  if (!occ) return null;
  return { code: occ.code, name: occ.name, how, score, ...(extra || {}) };
};

/** run tiers 1-4 over one already-cleaned string */
function matchCleaned(cleaned, index, st) {
  if (!cleaned) return null;
  if (REFUSE_BARE.has(cleaned)) return null;

  // 1. exact - the whole title IS a COR name
  if (st.exact) {
    const exact = index.byDense.get(cleaned.replace(/ /g, ""));
    if (exact && exact !== "AMBIGUOUS") {
      return { code: exact.code, name: exact.name, how: "exact", score: 1 };
    }
  }

  // 2. synonym - curated, longest phrase first, whole-word
  if (st.synonym) {
    const padded = " " + cleaned + " ";
    for (const syn of index.synonyms) {
      if (padded.includes(" " + syn.folded + " ")) {
        const h = hit(index, syn.code, "synonym", 0.9);
        if (h) return h;
      }
    }
  }

  const toks = contentTokens(cleaned, index.vocab, st.plural);
  if (!toks.length) return null;
  if (REFUSE_BARE.has(toks.join(" "))) return null;

  // 1b. exact again, this time on the plural-folded, stop-word-free form:
  // "operatori masini unelte" -> "operator masini unelte"
  if (st.exact && st.plural) {
    const exact2 = index.byDense.get(toks.join(""));
    if (exact2 && exact2 !== "AMBIGUOUS") {
      return { code: exact2.code, name: exact2.name, how: "exact", score: 0.98 };
    }
  }

  // 2b. alias - a paren-derived spelling of an official name. Ranked below the
  // curated synonym table on purpose: "asistent medical" is an alias of 226905
  // "asistent medical (studii superioare)" but the curated table sends it to
  // 222101 "asistent medical generalist", which is the profession people mean.
  if (st.exact && index.byAlias) {
    for (const d of [cleaned.replace(/ /g, ""), toks.join("")]) {
      const a = index.byAlias.get(d);
      if (a && a !== "AMBIGUOUS") return { code: a.code, name: a.name, how: "alias", score: 0.95 };
    }
  }

  // 3. phrase - a COR name sits contiguously inside the title
  if (st.phrase) {
    const p = bestContained(toks, index, "phrase");
    if (p) {
      const h = hit(index, p.code, "phrase", Math.round(Math.min(1, 0.7 + p.coverage * 0.3) * 100) / 100, { words: p.words });
      if (h) return h;
    }
  }

  // 4. subset - a COR name's words appear in order, with gaps
  if (st.subset) {
    const s = bestContained(toks, index, "subset");
    if (s) {
      const h = hit(index, s.code, "subset", Math.round(Math.min(1, 0.6 + s.coverage * 0.3) * 100) / 100, { words: s.words });
      if (h) return h;
    }
  }
  return null;
}

/** the separators a Romanian job title uses to glue two roles together */
const SEG_RE = /\s*[\/|,]\s*|\s+[-–—]\s+/;

/**
 * matchTitle(title, index, opts) -> { code, name, how, score } | null
 * opts.stages switches individual tiers off (used by tools/cor_bench.js).
 */
/**
 * Prefix tier - a generic title that is the OPENING of official occupation
 * names. COR has no bare "economist"; it has "economist banca" and
 * "economist-sef". A job titled just "Economist" is therefore a prefix of
 * several occupations and equal to none.
 *
 * If exactly one occupation starts with those words, that is the occupation.
 * If several do, we refuse and report the title as ambiguous rather than
 * picking one - inventing precision the data does not support is worse than
 * saying "this title is too generic to place".
 */
/**
 * Romanian plural and feminine forms, folded to the singular masculine COR
 * uses. "Muncitori necalificati" is not in COR; "muncitor necalificat în
 * agricultură" is. "Receptionera" is not; "recepționer de hotel" is.
 *
 * Deliberately conservative: only endings that are unambiguous in occupation
 * names, applied to whole words. Over-stemming would merge unrelated jobs.
 */
const PLURAL_RULES = [
  [/([a-z])ii$/i, "$1iu"],        // salarii -> salariu
  [/tori$/i, "tor"],              // muncitori -> muncitor, operatori -> operator
  [/eri$/i, "er"],                // ingineri -> inginer
  [/ari$/i, "ar"],                // bucatari -> bucatar
  [/oare$/i, "or"],               // vanzatoare -> vanzator
  [/([a-z])ati$/i, "$1at"],       // necalificati -> necalificat
  [/([a-z])iti$/i, "$1it"],
  [/([a-z])uti$/i, "$1ut"],
  [/([a-z])te$/i, "$1t"],
  [/([a-z])i$/i, "$1"],           // soferi -> sofer  (last, broadest)
];
const FEMININE_RULES = [
  [/eras[aă]$/i, "er"],
  [/([a-z])er[aă]$/i, "$1er"],    // receptionera -> receptioner
  [/([a-z])toare$/i, "$1tor"],    // ingrijitoare -> ingrijitor
  [/([a-z])ic[aă]$/i, "$1ic"],
];

function singularise(word) {
  const w = String(word || "");
  if (w.length < 5) return w;
  for (const [re, to] of FEMININE_RULES) if (re.test(w)) return w.replace(re, to);
  for (const [re, to] of PLURAL_RULES) if (re.test(w)) return w.replace(re, to);
  return w;
}

/** fold a whole title to singular masculine, word by word */
function singulariseTitle(t) {
  return String(t || "").split(/\s+/).map(singularise).join(" ");
}

/**
 * Subset tier: every meaningful word of the title appears somewhere in the
 * occupation name, in any order. "Operator date" is not a prefix of "operator
 * introducere, validare si prelucrare date", but both its words are in there.
 * Refuses when several occupations qualify, same as the prefix tier.
 */
function subsetMatch(cleaned, index) {
  const words = foldKey(cleaned).split(/\s+/).filter((w) => w.length >= 4);
  if (words.length < 2) return null;

  // Built once: word -> occupations containing it. Scanning all 4.422
  // occupations for every one of 34.000 titles is ~150 million string
  // comparisons and it froze the whole server for minutes. Intersecting
  // posting lists turns it into a lookup.
  if (!index._wordIndex) {
    const m = new Map();
    for (const occ of index.list) {
      for (const w of new Set(foldKey(String(occ.name || "")).split(/\s+/).filter((x) => x.length >= 4))) {
        let b = m.get(w);
        if (!b) { b = []; m.set(w, b); }
        b.push(occ);
      }
    }
    index._wordIndex = m;
  }

  // start from the rarest word's list, then keep only names holding every word
  const lists = words.map((w) => index._wordIndex.get(w)).filter(Boolean);
  if (lists.length !== words.length) return null;      // a word appears nowhere
  lists.sort((a, b) => a.length - b.length);
  if (lists[0].length > 400) return null;              // far too generic to place

  const hits = [];
  for (const occ of lists[0]) {
    const nk = foldKey(String(occ.name || ""));
    if (words.every((w) => nk.includes(w))) {
      hits.push(occ);
      if (hits.length > 6) break;
    }
  }
  if (hits.length === 1) return { code: hits[0].code, name: hits[0].name, how: "subset-cuvinte", score: 0.85 };
  if (hits.length > 1) {
    hits.sort((a, b) => String(a.name).length - String(b.name).length);
    return { ambiguous: true, how: "prefix-ambiguu", candidates: hits.slice(0, 5).map((o) => ({ code: o.code, name: o.name })) };
  }
  return null;
}

function prefixMatch(cleaned, index) {
  const joined = foldKey(String(cleaned || "").trim());
  if (!joined || joined.length < 5) return null;   // "sef", "sofer" are too broad

  // built once per index: first word -> occupations whose folded name starts
  // with it. Scanning all 4,422 occupations per title cost 163s over the whole
  // corpus; this bucket lookup brings it back under 15s.
  if (!index._prefixBuckets) {
    const m = new Map();
    for (const occ of index.list) {
      const nk = foldKey(String(occ.name || ""));
      if (!nk) continue;
      const head = nk.split(" ")[0];
      let b = m.get(head);
      if (!b) { b = []; m.set(head, b); }
      b.push({ occ, nk });
    }
    index._prefixBuckets = m;
  }

  const bucket = index._prefixBuckets.get(joined.split(" ")[0]);
  if (!bucket) return null;

  const hits = [];
  for (const { occ, nk } of bucket) {
    if (nk === joined) return { code: occ.code, name: occ.name, how: "prefix", score: 1 };
    if (nk.startsWith(joined + " ")) {
      hits.push(occ);
      if (hits.length > 8) break;
    }
  }
  if (hits.length === 1) return { code: hits[0].code, name: hits[0].name, how: "prefix", score: 0.9 };
  if (hits.length > 1) {
    return { ambiguous: true, how: "prefix-ambiguu", candidates: hits.slice(0, 5).map((o) => ({ code: o.code, name: o.name })) };
  }
  return null;
}

function matchTitle(title, index, opts) {
  const st = stagesWith(opts);
  const raw = st.entities ? decodeEntities(String(title == null ? "" : title)) : String(title == null ? "" : title);

  // 1a. exact on the UNTOUCHED title. This runs before any noise stripping,
  // because a title that already IS an official COR name must never be
  // damaged on the way in: "LUCRATOR BUCATARIE (SPALATOR VASE MARI)" is COR
  // 941201 verbatim, and stripping its parenthesis would lose it.
  if (st.exact) {
    const rawExact = index.byDense.get(denseKey(raw));
    if (rawExact && rawExact !== "AMBIGUOUS") {
      return { code: rawExact.code, name: rawExact.name, how: "exact", score: 1 };
    }
  }

  const cleaned = cleanTitle(raw, index, st);
  if (!cleaned) return null;

  const direct = matchCleaned(cleaned, index, st);
  if (direct) return direct;

  // 5. segments - "Montator / Electromecanic Macarale", "Picker - depozit alimentar"
  if (st.segment) {
    const segs = raw.split(SEG_RE).map((s) => cleanTitle(s, index, st)).filter((s) => s && s !== cleaned);
    let best = null;
    for (const seg of segs) {
      const m = matchCleaned(seg, index, st);
      if (!m) continue;
      if (!best) best = m;
      else if (m.code !== best.code) return null;   // two segments, two occupations -> refuse
    }
    if (best) return { ...best, how: "segment:" + best.how, score: Math.round(best.score * 0.95 * 100) / 100 };
  }

  // 5b. prefix - generic titles that open an official name
  if (st.prefix !== false) {
    const pm = prefixMatch(cleaned, index);
    if (pm && pm.code) return pm;
    if (pm && pm.ambiguous) return pm;          // reported, not counted as a match

    // the same, on the singular masculine form COR is written in
    const sing = singulariseTitle(cleaned);
    if (sing !== cleaned) {
      const direct2 = matchCleaned(sing, index, st);
      if (direct2) return { ...direct2, how: "singular:" + direct2.how };
      const pm2 = prefixMatch(sing, index);
      if (pm2 && pm2.code) return { ...pm2, how: "singular:prefix" };
      if (pm2 && pm2.ambiguous) return pm2;
    }

    // 5c. all words present, any order
    const sm = subsetMatch(cleaned, index) || subsetMatch(singulariseTitle(cleaned), index);
    if (sm && sm.code) return sm;
    if (sm && sm.ambiguous) return sm;
  }

  // 6. fuzzy - last resort, heavily guarded
  if (st.fuzzy) {
    const f = fuzzyMatch(cleaned.replace(/ /g, ""), index);
    if (f) {
      const occ = index.byCode.get(f.code);
      if (occ) {
        const dense = cleaned.replace(/ /g, "");
        const score = Math.max(0, 1 - f.dist / dense.length);
        return { code: occ.code, name: occ.name, how: `fuzzy (distance ${f.dist})`, score: Math.round(score * 100) / 100 };
      }
    }
  }

  // 7. honest unmatched
  return null;
}

/** the tier label a `how` belongs to, for tallies */
function tierOf(how) {
  if (!how) return "unmatched";
  if (how === "prefix-ambiguu") return "ambiguous";
  if (how === "prefix") return "prefix";
  if (how === "subset-cuvinte") return "subset";
  if (how.startsWith("singular:")) return "singular";
  if (how.startsWith("segment:")) return "segment";
  if (how.startsWith("fuzzy")) return "fuzzy";
  return how;
}

/** classifyAll(titles, index) -> [{ title, match }] plus a `how` tally */
function classifyAll(titles, index, opts) {
  const results = titles.map((title) => ({ title, match: matchTitle(title, index, opts) }));
  const tally = { exact: 0, synonym: 0, phrase: 0, subset: 0, segment: 0, fuzzy: 0, unmatched: 0 };
  for (const r of results) tally[tierOf(r.match && r.match.how)]++;
  return { results, tally };
}

module.exports = {
  loadCor, matchTitle, classifyAll, cleanTitle, foldKey, denseKey,
  decodeEntities, contentTokens, normToken, tierOf, STAGES, SYNONYM_GROUPS, REFUSE_BARE,
};
