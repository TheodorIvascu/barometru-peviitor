"use strict";
const fs = require("fs");
const path = require("path");

// Another engineer owns lib/aliases.js (exonyms + foreign/junk word lists).
// Require it defensively so this module keeps working when the file is absent.
let ALIASES = { exonyms: {}, foreign: [], junk: [] };
try { ALIASES = require("./aliases.js"); } catch (e) { /* not created yet */ }

const DIA = { "ă":"a","â":"a","î":"i","ș":"s","ț":"t","ş":"s","ţ":"t","Ă":"a","Â":"a","Î":"i","Ș":"s","Ț":"t","Ş":"s","Ţ":"t" };
const strip = (s) => String(s).replace(/[ăâîșțşţĂÂÎȘȚŞŢ]/g, (c) => DIA[c] || c);
const key = (s) => strip(s).toLowerCase().replace(/[^a-z0-9]/g, "");

const NOISE = /^(ap|apt|apart|apartament|camera|cam|etaj|et|bloc|bl|scara|sc|nr|numarul|strada|str|bulevardul|bulevard|bdul|bd|aleea|calea|soseaua|sos|intrarea|intr|piata|drumul|dr|cod|codpostal|judetul|jud|comuna|com|satul|sat|orasul|oras|municipiul|municipiu|mun|sectorul|sector)\.?$/i;
const POSTAL = /\b\d{5,6}\b/g;
const POSTAL_RO = /\b\d{6}\b/g;                      // Romanian postal codes are always 6 digits
const NUMONLY = /^[\d\W_]+$/;
// a segment naming a street/road is an address line, never a locality name
const STREET_WORDS = new Set(["str","strada","stradela","calea","bulevardul","bulevard","bdul","bd","soseaua","sos","aleea","piata","drumul","intrarea","intr","splaiul","prelungirea"]);
const isStreetLine = (part) => part.split(/\s+/).some((w) => STREET_WORDS.has(w.replace(/[.,]/g, "").toLowerCase()));

const JUNK_WORDS = new Set(["romania","all","nespecificat","remote","hybrid","onsite","medior","senior","junior","na","null","none","tbd","various","altele","oriunde","tara","strainatate","international","europa","ue","eu","test","street","road","avenue","strada","zona","area","office","hq","sediu","sediul","punct","lucru","toate","deplasare","diverse","variabil","central","centrala","national","nivel","activitate"]);
for (const w of ALIASES.junk || []) JUNK_WORDS.add(key(w));

const FOREIGN = new Set(["olanda","netherlands","nederland","germania","germany","deutschland","austria","osterreich","belgia","belgium","franta","france","italia","italy","spania","spain","portugalia","portugal","anglia","uk","england","irlanda","ireland","norvegia","norway","suedia","sweden","danemarca","denmark","finlanda","finland","elvetia","switzerland","cehia","czechia","slovacia","slovakia","ungaria","hungary","polonia","poland","bulgaria","grecia","greece","malta","cipru","cyprus","luxemburg","luxembourg","moldova","ucraina","ukraine","usa","sua","canada","mexic","china","israel","emirate","qatar","dubai","turcia","serbia","croatia","slovenia","estonia","letonia","lituania","islanda","japonia","coreea","australia","amsterdam","rotterdam","venlo","eindhoven","utrecht","denhaag","hague","venezia","padova","milano","roma","torino","napoli","firenze","bologna","bratislava","praha","prague","brno","dresden","munchen","munich","berlin","hamburg","frankfurt","stuttgart","koln","freiburg","weingarten","bruxelles","brussels","liege","antwerpen","gent","luxembourgcity","chisinau","wien","viena","vienna","salzburg","graz","linz","zurich","geneva","basel","bern","paris","lyon","marseille","madrid","barcelona","valencia","sevilla","lisabona","lisbon","porto","dublin","london","londra","manchester","birmingham","oslo","bergen","stockholm","goteborg","copenhaga","copenhagen","helsinki","budapesta","budapest","varsovia","warsaw","krakow","sofia","atena","athens","istanbul","ankara","foshan","shanghai","beijing","shenzhen","mexicocity","toronto","montreal","newyork","chicago","boston","seattle","texas","tanzania","kenya","egipt","maroc","india","vietnam","thailanda","singapore","zanzibar","paje","cavan","dublin","cork","galway","limerick","belfast","glasgow","edinburgh","cardiff","leeds","liverpool","bristol"]);
for (const w of ALIASES.foreign || []) FOREIGN.add(key(w));

// Well-known non-official (historic / foreign-language) names for Romanian
// localities that actually show up in job postings. Kept small and
// high-confidence on purpose - each entry was verified against real data
// mined from Solr, not guessed. Merged into the index at load time so they
// benefit from every existing lookup path (exact / substring / glued).
const BUILTIN_EXONYMS = {
  "bucharest": "București", "bukarest": "București", "bucarest": "București",
  "hermannstadt": "Sibiu",
  "temeswar": "Timișoara", "temesvar": "Timișoara",
  "marosvasarhely": "Târgu Mureș",
  "csikszereda": "Miercurea Ciuc",
  "szekelyudvarhely": "Odorheiu Secuiesc",
  "nagyvarad": "Oradea", "grosswardein": "Oradea",
  "klausenburg": "Cluj-Napoca", "kolozsvar": "Cluj-Napoca",
  "sighet": "Sighetu Marmației",
};

function loadIndex(dir) {
  const t0 = Date.now();
  const p = path.join(dir, "siruta_index.json");
  if (!fs.existsSync(p)) throw new Error("missing " + p);
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const idx = new Map();
  let localities = 0;
  for (const [k, v] of Object.entries(raw)) { idx.set(key(k), v.name); localities++; }
  // commune / parent names (SIRUTA lists localities, not commune heads)
  let parents = 0;
  const countyLocalities = new Map();               // countyKey -> Map(nameKey -> name)
  const addToCounty = (countyName, name) => {
    if (!countyName || !name) return;
    const ck = key(countyName);
    if (!countyLocalities.has(ck)) countyLocalities.set(ck, new Map());
    const m = countyLocalities.get(ck);
    const nk = key(name);
    if (nk && !m.has(nk)) m.set(nk, name);
  };
  const postal = new Map();                         // 6-digit postal code -> locality name
  const postalAmbiguous = new Set();
  const lp = path.join(dir, "siruta_localities.json");
  if (fs.existsSync(lp)) {
    for (const l of JSON.parse(fs.readFileSync(lp, "utf8"))) {
      const pn = l.parent && l.parent.name;
      if (pn) {
        const k = key(pn);
        if (k && !idx.has(k)) { idx.set(k, pn); parents++; }
      }
      addToCounty(l.county, l.name);
      addToCounty(l.county, pn);
      if (l.postal_code) {
        const code = String(l.postal_code);
        if (postal.has(code) && postal.get(code) !== l.name) postalAmbiguous.add(code);
        else postal.set(code, l.name);
      }
    }
    for (const code of postalAmbiguous) postal.delete(code); // ambiguous -> refuse to guess
  }

  let counties = 0;
  const cp = path.join(dir, "siruta_counties.json");
  if (fs.existsSync(cp)) {
    for (const c of JSON.parse(fs.readFileSync(cp, "utf8"))) {
      const k = key(c.name);
      if (k && !idx.has(k)) { idx.set(k, c.name); counties++; }
    }
  }

  // Merge in known exonyms (built-in + whatever lib/aliases.js supplies),
  // but never clobber an existing official name for the same key.
  let exonyms = 0;
  const exonymSource = { ...BUILTIN_EXONYMS, ...(ALIASES.exonyms || {}) };
  for (const [alt, official] of Object.entries(exonymSource)) {
    const ak = key(alt);
    if (!ak || idx.has(ak)) continue;
    idx.set(ak, official);
    exonyms++;
  }

  const buckets = new Map();
  for (const k of idx.keys()) {
    if (!buckets.has(k.length)) buckets.set(k.length, []);
    buckets.get(k.length).push(k);
  }
  return { idx, buckets, localities, counties, parents, exonyms, postal, countyLocalities, ms: Date.now() - t0 };
}

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

function fuzzy(k, index) {
  // Deliberately conservative: a wrong "correction" silently corrupts data,
  // which is worse than leaving a value unmatched.
  if (k.length < 6) return null;                       // too short to be safe
  const max = k.length <= 9 ? 1 : 2;
  const MAX_RATIO = 0.15;                              // <=15% of the word may differ

  let best = null, bestD = max + 1, ties = 0;
  for (let len = k.length - max; len <= k.length + max; len++) {
    for (const cand of index.buckets.get(len) || []) {
      if (cand.length < 6) continue;
      if (cand[0] !== k[0]) continue;                      // first letter must hold
      const d = lev(k, cand, max);
      if (d > max) continue;
      if (d < bestD) { bestD = d; best = cand; ties = 1; }
      else if (d === bestD && index.idx.get(cand) !== index.idx.get(best)) ties++;
    }
  }
  if (!best || bestD > max) return null;
  if (ties > 1) return null;                           // ambiguous -> refuse to guess
  if (bestD / Math.max(k.length, best.length) > MAX_RATIO) return null;
  return { name: index.idx.get(best), dist: bestD };
}

// an internal code such as RO-BUH-BUCHARESTSEIMAFOF is never a place
const looksLikeCode = (t) => {
  const v = t.trim();
  if (v.length < 6) return false;
  if (/[a-z]/.test(v)) return false;                 // must be all caps / digits
  return /^[A-Z0-9]+([-_/][A-Z0-9]+)+$/.test(v);
};

// "Sf. Gheorghe" -> "Sfantu Gheorghe" / "Sfanta Gheorghe"
// "Campulung-Muscel" -> "Campulung"   (historic qualifier dropped)
function aliases(part) {
  const out = [part];
  const abbrev = [
    [/^sf\.?\s+/i, "sfantu "], [/^sf\.?\s+/i, "sfanta "], [/^sfv\.?\s+/i, "sfantu "],
    [/^s\.?\s*gheorghe$/i, "sfantu gheorghe"],
    [/^dr\.?\s+/i, "doctor "], [/^gen\.?\s+/i, "general "],
  ];
  for (const [re, rep] of abbrev) if (re.test(part)) out.push(part.replace(re, rep));
  const tokens = part.split(/[\s-]+/).filter(Boolean);
  if (tokens.length > 1) {
    out.push(tokens.slice(0, -1).join(" "));          // drop the trailing qualifier
    out.push(tokens.slice(1).join(" "));              // or a leading one
  }
  return out;
}

function denoise(part) {
  return part.split(/\s+/).filter((w) => !NOISE.test(w) && !NUMONLY.test(w)).join(" ").trim();
}

// "X, Y" where Y names a county: look X up (exact, then a conservative typo
// fix) restricted to that county's own localities. This both resolves names
// too small/ambiguous for the global fuzzy pass and lets a stated county
// break a global tie between same-distance candidates in different counties.
function countyConfirmedMatch(candidatePart, countyKey, index) {
  const localMap = index.countyLocalities.get(countyKey);
  if (!localMap) return null;
  const ck = key(denoise(candidatePart) || candidatePart);
  if (!ck) return null;
  const hit = localMap.get(ck);
  if (hit) return { name: hit, how: "exact (county-confirmed)" };
  if (ck.length < 5) return null;
  const max = ck.length <= 9 ? 1 : 2;
  let best = null, bestD = max + 1, ties = 0;
  for (const [nk, name] of localMap) {
    if (Math.abs(nk.length - ck.length) > max) continue;
    const d = lev(ck, nk, max);
    if (d > max) continue;
    if (d < bestD) { bestD = d; best = name; ties = 1; }
    else if (d === bestD && name !== best) ties++;
  }
  if (!best || ties > 1) return null;
  if (bestD / Math.max(ck.length, key(best).length) > 0.15) return null;
  return { name: best, how: "typo-fixed (county-confirmed, distance " + bestD + ")" };
}

function classify(raw, index) {
  if (raw === undefined || raw === null || !String(raw).trim()) return { kind: "junk", how: "empty" };
  let s = String(raw).trim();

  const bare = strip(s).toLowerCase();
  if (/sector/.test(bare) && (/bucure/.test(bare) || /^sector\s*\d/.test(bare.trim()))) {
    return { kind: "fixed", value: "București", how: "sector to Bucuresti" };
  }

  // Romanian postal codes (always 6 digits) identify a locality directly and
  // are very reliable - captured before POSTAL stripping removes them below.
  const postalCodes = s.match(POSTAL_RO) || [];

  s = s.replace(POSTAL, " ").replace(/\s+/g, " ");
  const parts = s.split(/[,;/|]/).map((p) => p.trim()).filter(Boolean);

  // a part that is itself a county name - used to confirm/disambiguate
  // a neighbouring part ("X, Y" where Y is a county)
  const countyParts = parts.filter((p) => index.countyLocalities.has(key(p)));

  for (const part of parts) {
    if (looksLikeCode(part)) continue;                // codes are handled at the end
    let hit = index.idx.get(key(part));
    if (hit) return { kind: "fixed", value: hit, how: "exact" };
    for (const alt of aliases(part)) {
      if (alt === part) continue;
      const h = index.idx.get(key(alt));
      if (h) return { kind: "fixed", value: h, how: "alias" };
    }
    const cleaned = denoise(part);
    if (!cleaned) continue;
    hit = index.idx.get(key(cleaned));
    if (hit) return { kind: "fixed", value: hit, how: "address-stripped" };
    const words = cleaned.split(/[\s-]+/).filter(Boolean);   // hyphenated compounds ("Bucuresti-Ilfov") split too
    for (let len = Math.min(4, words.length); len >= 1; len--) {
      for (let i = 0; i + len <= words.length; i++) {
        const h = index.idx.get(key(words.slice(i, i + len).join(" ")));
        if (h) return { kind: "fixed", value: h, how: "substring" };
      }
    }
  }

  // "X, <county>" - resolve/disambiguate X against that county's own list
  for (const cp of countyParts) {
    const ck = key(cp);
    for (const part of parts) {
      if (part === cp || isStreetLine(part) || looksLikeCode(part)) continue;
      const k = key(part);
      if (!k || JUNK_WORDS.has(k) || FOREIGN.has(k)) continue;
      const m = countyConfirmedMatch(part, ck, index);
      if (m) return { kind: "fixed", value: m.name, how: m.how };
    }
  }

  // a bare 6-digit Romanian postal code pins the locality precisely
  for (const code of postalCodes) {
    const hit = index.postal.get(code);
    if (hit) return { kind: "fixed", value: hit, how: "postal-code" };
  }

  // glued qualifier: "Campulungmuscel" -> "Campulung"
  for (const part of parts) {
    if (isStreetLine(part) || looksLikeCode(part)) continue;
    const gk = key(part);
    if (gk.length < 10) continue;
    for (let cut = gk.length - 3; cut >= 7; cut--) {
      const hit = index.idx.get(gk.slice(0, cut));
      if (hit && gk.length - cut <= 8) return { kind: "fixed", value: hit, how: "glued qualifier" };
    }
  }

  for (const part of parts) {
    const k = key(part);
    if (!k || JUNK_WORDS.has(k)) continue;
    if (FOREIGN.has(k)) return { kind: "international", value: part.trim(), how: "known-foreign" };
  }

  for (const part of parts) {
    if (isStreetLine(part)) continue;              // address line: exact only, no guessing
    const k = key(denoise(part) || part);
    if (!k || JUNK_WORDS.has(k) || FOREIGN.has(k)) continue;
    const f = fuzzy(k, index);
    if (f && f.dist > 0) return { kind: "fixed", value: f.name, how: "typo-fixed (distance " + f.dist + ")" };
    if (f) return { kind: "fixed", value: f.name, how: "exact" };
  }

  // a phrase where every word is a known junk/filler word ("Sediul Central",
  // "Punct de lucru") is boilerplate, not a place - even though the whole
  // multi-word string itself was never registered as a single junk entry.
  const isJunkPhrase = (p) => {
    const words = p.split(/\s+/).filter(Boolean);
    return words.length > 0 && words.every((w) => JUNK_WORDS.has(key(w)));
  };
  const meaningful = parts.filter((p) => !JUNK_WORDS.has(key(p)) && !isJunkPhrase(p) && !NUMONLY.test(p) && /[a-z]/i.test(strip(p)) && !isStreetLine(p) && !looksLikeCode(p));
  if (!meaningful.length) return { kind: "junk", how: "not-a-place" };
  const cand = meaningful[0].trim();
  // a genuine place name is short (1-4 words); a longer capitalised phrase
  // is almost always a business/department description, not a location -
  // guessing "international" there would just be inventing a place.
  const wordCount = cand.split(/\s+/).filter(Boolean).length;
  if (/^[A-Z]/.test(strip(cand)) && cand.length > 2 && wordCount <= 4) {
    return { kind: "international", value: cand, how: "unknown-place" };
  }
  return { kind: "junk", how: "unrecognised" };
}

module.exports = { loadIndex, classify, key, strip };
