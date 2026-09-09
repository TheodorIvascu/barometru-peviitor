"use strict";
/**
 * Aduce rezultatul ultimei analize din release-ul de pe GitHub.
 *
 * Serverul de afișare nu rulează analiza: pe o găzduire gratuită discul e
 * efemer și ar pierde evidența intrărilor în fiecare zi. Analiza rulează într-un
 * GitHub Action, iar rezultatul ajunge aici, la pornire.
 *
 *   node tools/fetch-latest.js            aduce doar dacă lipsește
 *   node tools/fetch-latest.js --force    aduce oricum
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
const force = process.argv.includes("--force");

const url = (f) => `https://github.com/${REPO}/releases/download/${TAG}/${f}`;

async function descarca(fisier, destinatie, dezarhiveaza) {
  const r = await fetch(url(fisier), { redirect: "follow" });
  if (!r.ok) throw new Error(`${fisier}: HTTP ${r.status}`);
  const tmp = destinatie + ".tmp";
  const iesire = fs.createWriteStream(tmp);
  const intrare = Readable.fromWeb(r.body);
  await (dezarhiveaza ? pipeline(intrare, zlib.createGunzip(), iesire) : pipeline(intrare, iesire));
  fs.renameSync(tmp, destinatie);
  return fs.statSync(destinatie).size;
}

async function main() {
  fs.mkdirSync(RUNS, { recursive: true });
  const rezumat = path.join(RUNS, "latest.json");
  const randuri = path.join(RUNS, "jobs.ndjson");

  if (!force && fs.existsSync(rezumat) && fs.existsSync(randuri)) {
    console.log("rezultatul e deja pe disc; nu descarc nimic (--force ca să insist)");
    return;
  }

  console.log("aduc rezultatul din " + REPO + ", release " + TAG);
  const a = await descarca("latest.json", rezumat, false);
  console.log("  latest.json    " + Math.round(a / 1024) + " KB");
  const b = await descarca("jobs.ndjson.gz", randuri, true);
  console.log("  jobs.ndjson    " + Math.round(b / 1048576) + " MB");

  const s = JSON.parse(fs.readFileSync(rezumat, "utf8"));
  console.log("analiză din " + s.runAt + ": " + s.totals.trusted + " din " + s.totals.jobs + " anunțuri valide");
}

main().catch((e) => {
  // Lipsa rezultatului nu trebuie să oprească pornirea: serverul are seed-ul
  // livrat cu aplicația și arată cifre reale, doar fără lista de anunțuri.
  console.error("nu am putut aduce rezultatul: " + e.message);
  process.exit(process.env.STRICT_FETCH === "1" ? 1 : 0);
});
