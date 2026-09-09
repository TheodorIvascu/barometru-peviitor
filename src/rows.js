"use strict";
/**
 * Rândurile analizei, pe disc, nu în memorie.
 *
 * Un index de 88.000 de anunțuri înseamnă 66 MB de JSON. Ținut ca obiecte în
 * memorie ocupă ~220 MB, iar serializarea lui într-un singur șir la salvare a
 * urcat procesul la 784 MB. Planul gratuit de pe Render are 512 MB, deci
 * procesul ar fi fost oprit.
 *
 * Așa că rândurile se scriu câte unul pe linie și se citesc la fel, în flux:
 * memoria nu depinde de câte anunțuri sunt, ci de cât de mare e pagina cerută.
 * Fișierul e sortat descrescător după dată la scriere, deci citirea vine deja
 * în ordinea în care o afișăm și nu mai e nevoie să adunăm nimic ca să sortăm.
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { ROOT } = require("./env.js");

const FILE = path.join(ROOT, "runs", "jobs.ndjson");
const TMP = FILE + ".tmp";

/** Scrie rândurile, sortate după dată descrescător. Înlocuirea e atomică. */
async function write(rows) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const out = fs.createWriteStream(TMP, { encoding: "utf8" });
  for (const r of rows) {
    // write() întoarce false când tamponul e plin; fără așteptare aici, tot
    // fișierul s-ar aduna în memorie, adică exact ce încercăm să evităm
    if (!out.write(JSON.stringify(r) + "\n")) await new Promise((res) => out.once("drain", res));
  }
  await new Promise((res, rej) => { out.on("finish", res); out.on("error", rej); out.end(); });
  fs.renameSync(TMP, FILE);            // cititorii văd ori vechiul fișier, ori noul, niciodată unul pe jumătate
  return { file: FILE, rows: rows.length, bytes: fs.statSync(FILE).size };
}

const exists = () => fs.existsSync(FILE);

/**
 * Parcurge rândurile în ordinea din fișier și cheamă onRow pentru fiecare.
 * onRow poate întoarce "stop" ca să oprească citirea mai devreme.
 */
async function scan(onRow) {
  if (!exists()) return 0;
  const rl = readline.createInterface({ input: fs.createReadStream(FILE, { encoding: "utf8" }), crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }   // o linie stricată nu oprește restul
      n++;
      if (onRow(row) === "stop") break;
    }
  } finally {
    rl.close();
  }
  return n;
}

/**
 * Numără câte rânduri trec de filtru și adună doar pagina cerută.
 * Memoria folosită e cât pagina, indiferent de mărimea indexului.
 */
async function page(matches, from, size) {
  const items = [];
  let total = 0;
  await scan((row) => {
    if (!matches(row)) return;
    if (total >= from && items.length < size) items.push(row);
    total++;
  });
  return { total, items };
}

module.exports = { write, scan, page, exists, FILE };
