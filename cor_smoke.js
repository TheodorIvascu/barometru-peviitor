"use strict";
/**
 * Smoke test + coverage measurement for lib/cor.js.
 *
 * 1. Unit assertions on the synonym table's motivating cases.
 * 2. Coverage against the LIVE Solr `job` core (small right now - see
 *    lib/cor.js header / task notes: the core was wiped and re-indexed
 *    today and only holds ~220 docs).
 * 3. Coverage against the larger HISTORICAL title sample cached in
 *    cache/aggregate.json (36,096 distinct titles from the 87,749-doc index
 *    that existed before today's wipe) - this is the number that actually
 *    means something for judging the matcher.
 *
 * Usage: node cor_smoke.js
 */
const path = require("path");
const fs = require("fs");
const { loadCor, matchTitle, classifyAll } = require(path.join(__dirname, "lib", "cor.js"));

let Solr = null;
try { ({ Solr } = require(path.join(__dirname, "lib", "solr.js"))); } catch (e) { /* not available */ }

const index = loadCor(path.join(__dirname, "lib"));
console.log(`loaded ${index.list.length} COR occupations from lib/cor.json`);

// ---------------------------------------------------------------------------
// 1. unit assertions
// ---------------------------------------------------------------------------
const CASES = [
  // the motivating case from the task: 7 spellings, 1 code
  ["Angajam Sofer categoria CE URGENT!!! 200 euro/saptamana Ploiesti", "833201"],
  ["soferi", "833201"],
  ["Conducator auto", "833201"],
  ["Driver", "833201"],
  ["Sofer TIR internațional", "833201"],
  ["Angajam camion - transport marfa", "833201"],
  ["ANGAJAM SOFER cat. B+E", "833201"],
  // distinct driver sub-roles must NOT collapse into the generic bucket
  ["Sofer autobuz", "833101"],
  ["Sofer tramvai", "833103"],
  ["Sofer ambulanta", "832203"],
  // exact-tier: official COR name verbatim (with and without diacritics)
  ["Conducător auto transport rutier de mărfuri", "833201"],
  ["Muncitor necalificat la spargerea si taierea materialelor de constructii", "931302"],
  ["Asistent Medical Generalist", "222101"],
  // synonym-tier for the other required occupation groups
  ["vanzatoare cu experienta", "522101"],
  ["Bucatari - angajam urgent", "512001"],
  ["OSPATARI / CHELNERI", "513102"],
  ["Stivuitoristi cat. 1", "834403"],
  ["Agenti de securitate Sector 3", "541401"],
  ["Femei de serviciu", "911201"],
  ["Asistenti medicali generalisti", "222101"],
  ["Programatori Java (m/f/x)", "251202"],
  ["Contabili cu experienta", "331302"],
  ["Electricieni intretinere", "741307"],
  ["Sudori CO2", "721208"],
  ["Lacatusi mecanici", "721410"],
  ["Zidari cu experienta", "711205"],
  ["Dulgheri", "711501"],
  ["Curieri auto", "962101"],
  ["Casieri supermarket", "523003"],
  ["Macelari", "751103"],
  ["Brutari cofetari", "751201"],
  ["Croitorese", null], // NOT in the synonym table on purpose (only "croitoreasa" singular) - documents a real gap
  ["Mecanici auto", "723103"],
  // deliberate refusals - must stay null, never guess
  ["Inginer", null],
  ["Muncitor necalificat", null],
  ["Operator productie", null],
  ["Dispecer", "432201"], // NOT a refusal: COR has a genuine bare "dispecer" code (administrative), exact tier
  ["Dispecer Centru De Alarma", "541408"], // top historical title (866 occurrences) - exact COR name match
  ["", null],
  [null, null],
];

let pass = 0, fail = 0;
for (const [title, expected] of CASES) {
  const m = matchTitle(title, index);
  const got = m ? m.code : null;
  const ok = got === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "OK  " : "FAIL"} ${JSON.stringify(title)} -> ${got}${m ? " (" + m.how + ")" : ""} ${ok ? "" : "expected " + expected}`);
}
console.log(`\nunit: ${pass} passed, ${fail} failed\n`);

// ambiguity sanity check: collisions in the raw COR data must never resolve via exact tier
const ambiguousSample = [...index.byDense.entries()].find(([, v]) => v === "AMBIGUOUS");
console.log("sample ambiguous COR name (never exact-matched):", ambiguousSample && ambiguousSample[0]);

// ---------------------------------------------------------------------------
// helper: run classifyAll over a title->count map and report
// ---------------------------------------------------------------------------
function report(label, titleCounts) {
  const titles = [];
  const weight = new Map();
  for (const [t, c] of titleCounts) { titles.push(t); weight.set(t, c); }

  const { results, tally } = classifyAll(titles, index);
  const totalDistinct = titles.length;
  const totalWeighted = titles.reduce((s, t) => s + (weight.get(t) || 1), 0);
  let weightedMatched = 0;
  const unmatched = [];
  for (const r of results) {
    const w = weight.get(r.title) || 1;
    if (r.match) weightedMatched += w;
    else unmatched.push([r.title, w]);
  }
  unmatched.sort((a, b) => b[1] - a[1]);

  console.log(`\n=== ${label} ===`);
  console.log(`distinct titles: ${totalDistinct}`);
  console.log(`matched (distinct): ${totalDistinct - tally.unmatched} / ${totalDistinct} = ${(100 * (totalDistinct - tally.unmatched) / totalDistinct).toFixed(1)}%`);
  console.log(`  exact:   ${tally.exact}`);
  console.log(`  synonym: ${tally.synonym}`);
  console.log(`  fuzzy:   ${tally.fuzzy}`);
  console.log(`  none:    ${tally.unmatched}`);
  if (totalWeighted !== totalDistinct) {
    console.log(`matched (job-weighted): ${weightedMatched} / ${totalWeighted} = ${(100 * weightedMatched / totalWeighted).toFixed(1)}%`);
  }
  console.log(`top unmatched by frequency:`);
  for (const [t, c] of unmatched.slice(0, 20)) console.log(`  ${String(c).padStart(5)}  ${t}`);
}

(async () => {
  // ---- live Solr (small, ~220 docs today) ----
  if (Solr) {
    try {
      const solr = new Solr();
      const alive = await solr.ping();
      if (alive) {
        const n = await solr.count("*:*");
        console.log(`\nSolr job core is up, numFound=${n}`);
        const docs = await solr.sample("*:*", "title", Math.min(n, 5000));
        const counts = new Map();
        for (const d of docs) {
          const t = d.title;
          if (!t) continue;
          counts.set(t, (counts.get(t) || 0) + 1);
        }
        report(`LIVE Solr job core (n=${n})`, counts);
      } else {
        console.log("\nSolr not reachable - skipping live measurement");
      }
    } catch (e) {
      console.log("\nSolr measurement failed:", e.message);
    }
  }

  // ---- historical sample from cache/aggregate.json (87,749-doc snapshot) ----
  // NOTE: while this script was being developed, cache/aggregate.json was
  // overwritten in place by a concurrent process (another engineer's
  // dashboard.js/analytics.js run, presumably) - it went from
  // generatedAt=2026-08-19T14:56:52Z / jobs=87749 / distinctTitleCount=36096
  // to a fresh regeneration against today's tiny wiped-and-reindexed live
  // core (jobs=220 / distinctTitleCount=109), i.e. identical in substance to
  // the live Solr measurement above. That original 36k-title snapshot is no
  // longer on disk anywhere (no git history, no backups, no other cache file
  // holds full title-level data) and cannot be reconstructed in full - only
  // this fallback partial sample, captured earlier in the same session
  // straight from the original file, survives. Detect the swap and fall
  // back to that partial sample rather than silently reporting live-core
  // numbers twice under a "historical" label.
  const aggPath = path.join(__dirname, "cache", "aggregate.json");
  let usedFallback = false;
  if (fs.existsSync(aggPath)) {
    const agg = JSON.parse(fs.readFileSync(aggPath, "utf8"));
    const titleCounts = agg.data && agg.data.titleCounts;
    const looksSwapped = titleCounts && Object.keys(titleCounts).length < 1000; // was 36,096
    if (titleCounts && !looksSwapped) {
      report(`HISTORICAL sample (cache/aggregate.json, generatedAt=${agg.generatedAt}, jobs=${agg.data.jobs})`, Object.entries(titleCounts));
    } else {
      console.log(
        `\ncache/aggregate.json no longer holds the historical snapshot ` +
        `(generatedAt=${agg.generatedAt}, distinct titles=${titleCounts ? Object.keys(titleCounts).length : "?"} ` +
        `- was 36,096 as of the original 2026-08-19T14:56:52Z run). It was overwritten mid-session by ` +
        `another process. Falling back to the partial historical sample captured earlier this session.`
      );
      usedFallback = true;
    }
  } else {
    usedFallback = true;
  }

  if (usedFallback) {
    // (a) the top-40-by-frequency slice of the original 36,096-distinct-title,
    //     87,749-job cache/aggregate.json, read and printed earlier in this
    //     session, before it was overwritten
    const FALLBACK_TOP40 = [
      ["Shuffler", 2227], ["Asistent Medical Generalist", 913],
      ["Tehnician Mentenanta Electromecanica Automatica Echipamente Industriale", 873],
      ["Dispecer Centru De Alarma", 866], ["Head of Back Office & Cash Management", 831],
      ["Manipulant Marfuri", 709], ["Mecanic intretinere utilaje - Fabrica pavaje - Sector 6", 619],
      ["GALLEY - Exective Chef (Ocean - EU citizens only)", 612], ["Tehnician Sudura", 581],
      ["Consilier/expert/inspector/referent/economist In Economie Generala", 573],
      ["Manipulant marfa", 514], ["Conducator Auto Transport Rutier De Marfuri", 481],
      ["Ajutor Bucatar", 475], ["Partener Clienti Retail - perioada determinata", 463],
      ["LUCRATOR COMERCIAL", 452], ["Lucrator Comercial", 445], ["Lucrator Gestionar", 430],
      ["Operator productie", 424], ["Ucenic", 421], ["Ingrijitor De Copii", 419],
      ["Bucatar", 398], ["Ambalator Manual", 376], ["Femeie de serviciu", 375],
      ["Personal curatenie", 374], ["Analist Calitate- contract temporar 12 luni", 370],
      ["Agenti de securitate", 352], ["Tehnician masini si utilaje", 352],
      ["Sef Sectie Industrie Prelucratoare", 351],
      ["Muncitor necalificat la spargerea si taierea materialelor de constructii", 350],
      ["Personal de noapte pentru hotel", 346], ["Agent Imobiliar -Imozone Business Consulting", 346],
      ["Lucratori in Productie- Fabrica/ Iesire Sector 6", 346],
      ["Tamplar avansat pentru executie mobilier Pal si Mdf", 344],
      ["Personal depozit colete - Transport de la Pacii", 344],
      ["Operator etichetare produse", 343], ["Branch Manager - Braila", 342],
      ["Agenti Securitate Sector 3", 341], ["Femeie De Serviciu", 313],
      ["Conducător auto transport rutier de mărfuri", 287], ["Mecanic intretinere utilaje", 285],
    ];
    const pool = new Map(FALLBACK_TOP40);

    // (b) cache/category_assignments.json is untouched (still Aug-19-era,
    //     generatedAt=2026-08-19T14:56:58Z, same run as the original
    //     aggregate.json) - fold in its per-category example titles too
    const catPath = path.join(__dirname, "cache", "category_assignments.json");
    if (fs.existsSync(catPath)) {
      const cat = JSON.parse(fs.readFileSync(catPath, "utf8"));
      for (const item of (cat.data && cat.data.items) || []) {
        for (const ex of item.examples || []) if (!pool.has(ex)) pool.set(ex, 1);
      }
    }
    report(`HISTORICAL sample (PARTIAL fallback: top-40 by frequency + category examples, ${pool.size} titles - see note above)`, pool);
  }
})();
