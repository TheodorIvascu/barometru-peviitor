"use strict";
/**
 * Aduce rezultatul ultimei analize din release-ul de pe GitHub.
 *
 * Serverul de afișare nu rulează analiza: pe o găzduire gratuită discul e
 * efemer și ar pierde evidența intrărilor în fiecare zi. Analiza rulează într-un
 * GitHub Action, iar rezultatul ajunge aici.
 *
 * Se poate folosi în două feluri:
 *   node tools/fetch-latest.js [--force]   din linia de comandă
 *   require(...).sincronizeaza()           din server, la pornire și periodic
 *
 * Repo-ul e public, deci nu e nevoie de niciun token.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");
const { ROOT } = require("../src/env.js");

const REPO = process.env.BAROMETRU_REPO || "TheodorIvascu/barometru-peviitor";
const TAG = process.env.BAROMETRU_RELEASE || "analiza";
const RUNS = path.join(ROOT, "runs");
const REZUMAT = path.join(RUNS, "latest.json");
const RANDURI = path.join(RUNS, "jobs.ndjson");

const url = (f) => `https://github.com/${REPO}/releases/download/${TAG}/${f}`;

async function descarca(fisier, destinatie, dezarhiveaza) {
  const r = await fetch(url(fisier), { redirect: "follow" });
  if (!r.ok) throw new Error(`${fisier}: HTTP ${r.status}`);
  const tmp = destinatie + ".tmp";
  const iesire = fs.createWriteStream(tmp);
  const intrare = Readable.fromWeb(r.body);
  await (dezarhiveaza ? pipeline(intrare, zlib.createGunzip(), iesire) : pipeline(intrare, iesire));
  fs.renameSync(tmp, destinatie);          // fișierul apare întreg sau deloc
  return fs.statSync(destinatie).size;
}

/** data analizei aflate deja pe disc, sau null */
function dataLocala() {
  try { return JSON.parse(fs.readFileSync(REZUMAT, "utf8")).runAt || null; } catch { return null; }
}

/**
 * Aduce rezultatul dacă e mai nou decât ce avem. Nu aruncă niciodată: o
 * descărcare eșuată nu trebuie să oprească serverul, care are oricum seed-ul.
 *
 * @returns {Promise<{adus: boolean, motiv?: string, runAt?: string}>}
 */
async function sincronizeaza(opts = {}) {
  const log = opts.log || (() => {});
  try {
    fs.mkdirSync(RUNS, { recursive: true });
    const local = dataLocala();
    const areRanduri = fs.existsSync(RANDURI);

    // întrebăm întâi doar rezumatul, 240 KB, ca să nu tragem 11 MB degeaba
    const r = await fetch(url("latest.json"), { redirect: "follow" });
    if (!r.ok) throw new Error("latest.json: HTTP " + r.status);
    const departe = await r.json();

    if (areRanduri && local && departe.runAt && departe.runAt <= local) {
      return { adus: false, motiv: "avem deja analiza din " + local };
    }

    log("aduc analiza din " + departe.runAt);
    fs.writeFileSync(REZUMAT, JSON.stringify(departe), "utf8");
    const octeti = await descarca("jobs.ndjson.gz", RANDURI, true);
    log("adus: " + Math.round(octeti / 1048576) + " MB de rânduri, "
      + departe.totals.trusted + " din " + departe.totals.jobs + " anunțuri valide");
    return { adus: true, runAt: departe.runAt };
  } catch (e) {
    log("nu am putut aduce rezultatul: " + e.message);
    return { adus: false, motiv: e.message };
  }
}

module.exports = { sincronizeaza, dataLocala };

if (require.main === module) {
  const force = process.argv.includes("--force");
  if (force) { try { fs.unlinkSync(RANDURI); } catch { /* nu exista */ } }
  sincronizeaza({ log: (m) => console.log("  " + m) })
    .then((r) => console.log(r.adus ? "gata" : "nimic de făcut: " + r.motiv));
}
