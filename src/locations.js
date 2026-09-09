"use strict";
/**
 * Location classifier against the SIRUTA registry (data/siruta_*.json).
 *
 * classify(raw, index) -> { kind, value?, how, county? }
 *   kind "fixed"          a Romanian locality was recognised; value is its official name
 *   kind "international"  a foreign place, or an unknown capitalised name
 *   kind "junk"           not a place: empty, placeholder, address-only, gibberish
 *
 * Deliberately conservative. A wrong match is worse than no match, so fuzzy
 * matching refuses short names, ties and anything more than ~15% different.
 *
 * Ported from peviitor-doctor/lib/locations.js with one addition: the index
 * also knows the county of every locality, so a recognised place can be put
 * on the map.
 */
const fs = require("fs");
const path = require("path");

let ALIASES = { exonyms: {}, foreign: [], junk: [] };
try { ALIASES = require("./aliases.js"); } catch { /* optional */ }

const DIA = { "ă":"a","â":"a","î":"i","ș":"s","ț":"t","ş":"s","ţ":"t","Ă":"a","Â":"a","Î":"i","Ș":"s","Ț":"t","Ş":"s","Ţ":"t" };
const strip = (s) => String(s).replace(/[ăâîșțşţĂÂÎȘȚŞŢ]/g, (c) => DIA[c] || c);
const key = (s) => strip(s).toLowerCase().replace(/[^a-z0-9]/g, "");

const NOISE = /^(ap|apt|apart|apartament|camera|cam|etaj|et|bloc|bl|scara|sc|nr|numarul|strada|str|bulevardul|bulevard|bdul|bd|aleea|calea|soseaua|sos|intrarea|intr|piata|drumul|dr|cod|codpostal|judetul|jud|comuna|com|satul|sat|orasul|oras|municipiul|municipiu|mun|sectorul|sector)\.?$/i;
const POSTAL = /\b\d{5,6}\b/g;
const POSTAL_RO = /\b\d{6}\b/g;
const NUMONLY = /^[\d\W_]+$/;
const STREET_WORDS = new Set(["str","strada","stradela","calea","bulevardul","bulevard","bdul","bd","soseaua","sos","aleea","piata","drumul","intrarea","intr","splaiul","prelungirea"]);
const isStreetLine = (part) => part.split(/\s+/).some((w) => STREET_WORDS.has(w.replace(/[.,]/g, "").toLowerCase()));

// placeholders: a value that names no place at all
const PLACEHOLDER_WORDS = new Set(["romania","all","nespecificat","remote","hybrid","onsite","na","null","none","tbd","various","altele","oriunde","tara","strainatate","international","europa","ue","eu","toate","diverse","variabil","national"]);
const JUNK_WORDS = new Set([...PLACEHOLDER_WORDS, "medior","senior","junior","test","street","road","avenue","strada","zona","area","office","hq","sediu","sediul","punct","lucru","deplasare","central","centrala","nivel","activitate"]);
for (const w of ALIASES.junk || []) JUNK_WORDS.add(key(w));

const FOREIGN = new Set(["olanda","netherlands","nederland","germania","germany","deutschland","austria","osterreich","belgia","belgium","franta","france","italia","italy","spania","spain","portugalia","portugal","anglia","uk","england","irlanda","ireland","norvegia","norway","suedia","sweden","danemarca","denmark","finlanda","finland","elvetia","switzerland","cehia","czechia","slovacia","slovakia","ungaria","hungary","polonia","poland","bulgaria","grecia","greece","malta","cipru","cyprus","luxemburg","luxembourg","moldova","ucraina","ukraine","usa","sua","canada","mexic","china","israel","emirate","qatar","dubai","turcia","serbia","croatia","slovenia","estonia","letonia","lituania","islanda","japonia","coreea","australia","amsterdam","rotterdam","venlo","eindhoven","utrecht","denhaag","hague","venezia","padova","milano","roma","torino","napoli","firenze","bologna","bratislava","praha","prague","brno","dresden","munchen","munich","berlin","hamburg","frankfurt","stuttgart","koln","freiburg","weingarten","bruxelles","brussels","liege","antwerpen","gent","luxembourgcity","chisinau","wien","viena","vienna","salzburg","graz","linz","zurich","geneva","basel","bern","paris","lyon","marseille","madrid","barcelona","valencia","sevilla","lisabona","lisbon","porto","dublin","london","londra","manchester","birmingham","oslo","bergen","stockholm","goteborg","copenhaga","copenhagen","helsinki","budapesta","budapest","varsovia","warsaw","krakow","sofia","atena","athens","istanbul","ankara","foshan","shanghai","beijing","shenzhen","mexicocity","toronto","montreal","newyork","chicago","boston","seattle","texas","tanzania","kenya","egipt","maroc","india","vietnam","thailanda","singapore","zanzibar","paje","cavan","cork","galway","limerick","belfast","glasgow","edinburgh","cardiff","leeds","liverpool","bristol"]);
for (const w of ALIASES.foreign || []) FOREIGN.add(key(w));

const BUILTIN_EXONYMS = {
  "bucharest": "București", "bukarest": "București", "bucarest": "București",
  "hermannstadt": "Sibiu", "temeswar": "Timișoara", "temesvar": "Timișoara",
  "marosvasarhely": "Târgu Mureș", "csikszereda": "Miercurea Ciuc", "szekelyudvarhely": "Odorheiu Secuiesc",
  "nagyvarad": "Oradea", "grosswardein": "Oradea", "klausenburg": "Cluj-Napoca", "kolozsvar": "Cluj-Napoca",
  "sighet": "Sighetu Marmației",
};

const BUCHAREST = "București";

function loadIndex(dir) {
  const t0 = Date.now();
  const p = path.join(dir, "siruta_index.json");
  if (!fs.existsSync(p)) throw new Error("missing " + p);
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));

  const idx = new Map();                    // nameKey -> official name

  // nameKey -> { county, code }. SIRUTA type codes rank administrative weight:
  // 1 municipiu reședință de județ ... 9 reședință municipiu ... 22 sat reședință
  // de comună, 23 sat. "Târgoviște" is a county seat in Dâmbovița and a village
  // in Timiș; a job saying "Târgoviște" means the city. The lowest code wins;
  // only a tie between different counties leaves the name ambiguous (null).
  const best = new Map();
  const remember = (name, county, code) => {
    if (!name || !county) return;
    const nk = key(name);
    if (!nk) return;
    const c = code == null ? 50 : code;
    const cur = best.get(nk);
    if (!cur || c < cur.code) best.set(nk, { county, code: c });
    else if (c === cur.code && cur.county !== county) best.set(nk, { county: null, code: c });
  };

  // the index file carries type labels; the localities file maps labels to codes
  const codeOfLabel = new Map();
  const lp = path.join(dir, "siruta_localities.json");
  const localitiesRaw = fs.existsSync(lp) ? JSON.parse(fs.readFileSync(lp, "utf8")) : [];
  for (const l of localitiesRaw) if (l.type_label && l.type != null) codeOfLabel.set(l.type_label, Math.min(l.type, codeOfLabel.get(l.type_label) ?? 99));

  let localities = 0;
  for (const [k, v] of Object.entries(raw)) { idx.set(key(k), v.name); remember(v.name, v.county, codeOfLabel.get(v.type)); localities++; }

  let parents = 0;
  const countyLocalities = new Map();       // countyKey -> Map(nameKey -> name)
  const addToCounty = (countyName, name) => {
    if (!countyName || !name) return;
    const ck = key(countyName);
    if (!countyLocalities.has(ck)) countyLocalities.set(ck, new Map());
    const m = countyLocalities.get(ck);
    const nk = key(name);
    if (nk && !m.has(nk)) m.set(nk, name);
  };
  const postal = new Map();
  const postalAmbiguous = new Set();
  {
    for (const l of localitiesRaw) {
      const pn = l.parent && l.parent.name;
      if (pn) {
        const k = key(pn);
        if (k && !idx.has(k)) { idx.set(k, pn); parents++; }
        remember(pn, l.county, l.parent.type);
      }
      remember(l.name, l.county, l.type);
      addToCounty(l.county, l.name);
      addToCounty(l.county, pn);
      if (l.postal_code) {
        const code = String(l.postal_code);
        if (postal.has(code) && postal.get(code) !== l.name) postalAmbiguous.add(code);
        else postal.set(code, l.name);
      }
    }
    for (const code of postalAmbiguous) postal.delete(code);
  }

  const countyNames = new Map();            // countyKey -> county name
  const cp = path.join(dir, "siruta_counties.json");
  if (fs.existsSync(cp)) {
    for (const c of JSON.parse(fs.readFileSync(cp, "utf8"))) {
      const k = key(c.name);
      if (!k) continue;
      countyNames.set(k, c.name);
      if (!idx.has(k)) idx.set(k, c.name);
      best.set(k, { county: c.name, code: 0 });   // a county named as a location sits in itself
    }
  }
  best.set(key(BUCHAREST), { county: BUCHAREST, code: 0 });
  const countyOf = new Map();               // nameKey -> county name, or null when still ambiguous
  for (const [nk, b] of best) countyOf.set(nk, b.county);

  let exonyms = 0;
  for (const [alt, official] of Object.entries({ ...BUILTIN_EXONYMS, ...(ALIASES.exonyms || {}) })) {
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
  return { idx, buckets, localities, parents, exonyms, postal, countyLocalities, countyNames, countyOf, ms: Date.now() - t0 };
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
  if (k.length < 6) return null;
  const max = k.length <= 9 ? 1 : 2;
  let best = null, bestD = max + 1, ties = 0;
  for (let len = k.length - max; len <= k.length + max; len++) {
    for (const cand of index.buckets.get(len) || []) {
      if (cand.length < 6 || cand[0] !== k[0]) continue;
      const d = lev(k, cand, max);
      if (d > max) continue;
      if (d < bestD) { bestD = d; best = cand; ties = 1; }
      else if (d === bestD && index.idx.get(cand) !== index.idx.get(best)) ties++;
    }
  }
  if (!best || bestD > max || ties > 1) return null;
  if (bestD / Math.max(k.length, best.length) > 0.15) return null;
  return { name: index.idx.get(best), dist: bestD };
}

const looksLikeCode = (t) => {
  const v = t.trim();
  if (v.length < 6 || /[a-z]/.test(v)) return false;
  return /^[A-Z0-9]+([-_/][A-Z0-9]+)+$/.test(v);
};

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
    out.push(tokens.slice(0, -1).join(" "));
    out.push(tokens.slice(1).join(" "));
  }
  return out;
}

const denoise = (part) => part.split(/\s+/).filter((w) => !NOISE.test(w) && !NUMONLY.test(w)).join(" ").trim();

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

const splitParts = (s) => s.split(/[,;/|]/).map((p) => p.trim()).filter(Boolean);

/** the county a recognised locality belongs to; null when the registry cannot say */
function countyFor(raw, result, index) {
  if (!result || result.kind !== "fixed") return null;
  const nk = key(result.value);
  if (nk === key(BUCHAREST)) return BUCHAREST;
  const c = index.countyOf.get(nk);
  if (c) return c;
  // the name exists in several counties: trust a county named alongside it
  for (const part of splitParts(String(raw))) {
    const cn = index.countyNames.get(key(part));
    if (cn) return cn;
  }
  return null;
}

function classify(raw, index) {
  if (raw === undefined || raw === null || !String(raw).trim()) return { kind: "junk", how: "empty" };
  let s = String(raw).trim();

  const bare = strip(s).toLowerCase();
  if (/sector/.test(bare) && (/bucure/.test(bare) || /^sector\s*\d/.test(bare.trim()))) {
    return { kind: "fixed", value: BUCHAREST, how: "sector to Bucuresti" };
  }

  const postalCodes = s.match(POSTAL_RO) || [];
  s = s.replace(POSTAL, " ").replace(/\s+/g, " ");
  const parts = splitParts(s);
  const countyParts = parts.filter((p) => index.countyLocalities.has(key(p)));

  for (const part of parts) {
    if (looksLikeCode(part)) continue;
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
    const words = cleaned.split(/[\s-]+/).filter(Boolean);
    for (let len = Math.min(4, words.length); len >= 1; len--) {
      for (let i = 0; i + len <= words.length; i++) {
        const h = index.idx.get(key(words.slice(i, i + len).join(" ")));
        if (h) return { kind: "fixed", value: h, how: "substring" };
      }
    }
  }

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

  for (const code of postalCodes) {
    const hit = index.postal.get(code);
    if (hit) return { kind: "fixed", value: hit, how: "postal-code" };
  }

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
    if (isStreetLine(part)) continue;
    const k = key(denoise(part) || part);
    if (!k || JUNK_WORDS.has(k) || FOREIGN.has(k)) continue;
    const f = fuzzy(k, index);
    if (f && f.dist > 0) return { kind: "fixed", value: f.name, how: "typo-fixed (distance " + f.dist + ")" };
    if (f) return { kind: "fixed", value: f.name, how: "exact" };
  }

  const isJunkPhrase = (p) => {
    const words = p.split(/\s+/).filter(Boolean);
    return words.length > 0 && words.every((w) => JUNK_WORDS.has(key(w)));
  };
  const meaningful = parts.filter((p) => !JUNK_WORDS.has(key(p)) && !isJunkPhrase(p) && !NUMONLY.test(p) && /[a-z]/i.test(strip(p)) && !isStreetLine(p) && !looksLikeCode(p));
  if (!meaningful.length) {
    // every part is either a placeholder word or an address line: say which
    const allPlaceholder = parts.length > 0 && parts.every((p) => PLACEHOLDER_WORDS.has(key(p)) || p.split(/\s+/).every((w) => PLACEHOLDER_WORDS.has(key(w))));
    return { kind: "junk", how: allPlaceholder ? "placeholder" : "not-a-place" };
  }
  const cand = meaningful[0].trim();
  const wordCount = cand.split(/\s+/).filter(Boolean).length;
  if (/^[A-Z]/.test(strip(cand)) && cand.length > 2 && wordCount <= 4) {
    return { kind: "international", value: cand, how: "unknown-place" };
  }
  return { kind: "junk", how: "unrecognised" };
}

module.exports = { loadIndex, classify, countyFor, key, strip };
