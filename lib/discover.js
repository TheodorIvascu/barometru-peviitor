"use strict";
/**
 * lib/discover.js - let the model find problems our rules do not encode.
 *
 * Every other AI call in this app judges something a rule already flagged.
 * This one is the opposite: it reads a real sample of the index and reports
 * what looks wrong to a person, including things nobody wrote a rule for.
 *
 * Guard rails, because a model inventing defects would be worse than useless:
 *   - it sees REAL rows only, sampled from the live index
 *   - it must quote the exact title or company it is talking about, and we
 *     verify each quote exists in the sample before showing the finding
 *   - it is told what we already check, so it does not re-report known rules
 *   - findings carry an example, so every claim can be looked at
 */
const path = require("path");
const fs = require("fs");
const { Solr } = require(path.join(__dirname, "solr.js"));
const llm = require(path.join(__dirname, "llm.js"));

const CACHE = path.join(__dirname, "..", "cache", "discover.json");

const INSTRUCTION = [
  "Esti un analist de calitate a datelor. Primesti un esantion REAL de anunturi de job din indexul peviitor.ro.",
  "Sarcina ta: gaseste probleme pe care regulile automate NU le prind.",
  "",
  "Reguli pe care le verificam deja - NU le raporta:",
  "titluri cu HTML, titluri integral cu majuscule, duplicate titlu+companie, telefon sau email in titlu,",
  "locatii care nu sunt localitati, locatii doar la nivel de tara, CIF invalid sau cu alt numar de cifre,",
  "companii scrise fara majuscule, HTML in numele companiei, etichete cu diacritice sau prea multe,",
  "lipsa modului de lucru, lipsa etichetelor, url-uri stricate, continut pentru adulti.",
  "",
  "Cauta altceva: titluri care sunt de fapt descrieri sau reclame, titluri care contin salariul sau conditii,",
  "titluri in alta limba decat postul, nume de companie care sunt de fapt platforme sau agentii,",
  "etichete care nu au legatura cu jobul, anunturi care par recrutare in masa, orice tipar suspect.",
  "",
  "Pentru fiecare problema gasita dai: un nume scurt, o explicatie de o propozitie, cate randuri din esantion",
  "par afectate, si CITATUL EXACT al unui titlu sau nume de companie din esantion ca dovada.",
  "Citatul trebuie copiat literal din datele primite. Daca nu poti cita, nu raporta.",
  "Maxim 6 probleme. Daca datele arata curat, returneaza lista goala.",
  "",
  'Raspunde DOAR cu JSON: [{"nume":"...","explicatie":"...","afectate":3,"exemplu":"titlul exact"}]',
].join(String.fromCharCode(10));

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return null; }
}

/**
 * @param {number} sample how many real rows to show the model
 */
async function discover({ sample = 120 } = {}) {
  const solr = new Solr({ core: "job" });
  const total = await solr.count("*:*");

  // a random window, so repeated runs do not keep looking at the same corner
  const start = Math.max(0, Math.floor(Math.random() * Math.max(1, total - sample)));
  const j = await solr._get(
    `/select?q=*:*&fl=${encodeURIComponent("title,company,location,tags,workmode,salary")}&rows=${sample}&start=${start}&wt=json`
  );
  const rows = j.response.docs.map((d) => ({
    titlu: d.title || "",
    companie: d.company || "",
    locatie: Array.isArray(d.location) ? d.location.join(", ") : (d.location || ""),
    etichete: Array.isArray(d.tags) ? d.tags.slice(0, 8) : [],
    mod: d.workmode || null,
  }));

  let out;
  try {
    out = await llm.askBalanced({
      system: INSTRUCTION,
      user: JSON.stringify(rows, null, 1),
      maxTokens: 1800,
      only: ["gemini", "groq", "claude"],
    });
  } catch (e) {
    return { ok: false, error: e.message, budgetExhausted: !!e.budgetExhausted };
  }

  let parsed = null;
  const m = out.text.match(/\[[\s\S]*\]/);
  try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
  if (!Array.isArray(parsed)) return { ok: false, error: "raspuns neasteptat", raw: out.text.slice(0, 200) };

  // every finding must quote something that is actually in the sample
  const haystack = rows.map((r) => (r.titlu + " " + r.companie).toLowerCase());
  const findings = [];
  const rejected = [];
  for (const f of parsed) {
    const quote = String(f.exemplu || "").trim();
    const ok = quote && haystack.some((h) => h.includes(quote.toLowerCase().slice(0, 40)));
    const item = {
      nume: String(f.nume || "").slice(0, 80),
      explicatie: String(f.explicatie || "").slice(0, 240),
      afectate: Number(f.afectate) || 0,
      exemplu: quote.slice(0, 160),
    };
    if (ok) findings.push(item);
    else rejected.push({ ...item, motiv: "citatul nu apare in esantion" });
  }

  const result = {
    ok: true,
    at: new Date().toISOString(),
    sample: rows.length,
    total,
    provider: out.provider + "/" + out.model,
    tokens: out.tokens,
    findings,
    rejected,
  };
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(result), "utf8");
  return result;
}

module.exports = { discover, readCache };
