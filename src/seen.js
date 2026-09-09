"use strict";
/**
 * Evidența intrărilor: când a apărut fiecare anunț la noi, prima dată.
 *
 * Câmpul `date` din index este data ultimei extrageri, nu a primei apariții:
 * indexul se re-extrage continuu, iar cel mai vechi `date` din tot indexul are
 * două săptămâni. Deci nu se poate afla din el ce a intrat astăzi.
 *
 * Fișierul de aici ține minte, pentru fiecare adresă, ziua în care am văzut-o
 * prima oară. Prima rulare stabilește doar linia de plecare: totul pare nou,
 * deci nu se raportează nimic. De la a doua rulare, diferența are sens.
 *
 * Se ține o singură hartă mare, `first`. A doua hartă, cu ultima zi în care
 * fiecare adresă a fost văzută, ar dubla consumul de memorie pentru o
 * informație de care avem nevoie doar la adresele care au dispărut, adică la
 * câteva sute. Așa că lipsa se notează separat, în `missing`, și abia de acolo
 * se curăță după PRUNE_DAYS.
 */
const fs = require("fs");
const path = require("path");
const { ROOT } = require("./env.js");

const FILE = path.join(ROOT, "runs", "seen.json");
const PRUNE_DAYS = 60;
const day = (t) => new Date(t).toISOString().slice(0, 10);

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return {
      since: raw.since || null,
      first: new Map(Object.entries(raw.first || {})),
      missing: new Map(Object.entries(raw.missing || {})),
    };
  } catch {
    return { since: null, first: new Map(), missing: new Map() };
  }
}

/**
 * Marchează fiecare anunț cu ziua primei apariții și cu vechimea la noi,
 * apoi salvează evidența actualizată.
 *
 * @returns {{baseline: boolean, since: string, today: string, fresh: number, gone: number, tracked: number}}
 */
function mark(jobs, now) {
  const today = day(now);
  const store = load();
  const baseline = store.first.size === 0;

  let fresh = 0;
  const present = new Set();
  for (const e of jobs) {
    present.add(e.url);
    // „nou” înseamnă absent din evidență înainte de această rulare, nu „are
    // data de azi”: la prima rulare toate primesc data de azi.
    let first = store.first.get(e.url);
    const known = first !== undefined;
    if (!known) { first = today; store.first.set(e.url, today); if (!baseline) fresh++; }
    if (store.missing.has(e.url)) store.missing.delete(e.url);   // a revenit în index
    e.firstSeen = first;
    e.isNew = !baseline && !known;
    e.daysHere = Math.max(0, Math.round((Date.parse(today) - Date.parse(first)) / 86400000));
  }

  // adresele care nu mai sunt în index: le notăm de când lipsesc, apoi le uităm
  const cutoff = Date.parse(today) - PRUNE_DAYS * 86400000;
  let gone = 0;
  for (const url of store.first.keys()) {
    if (present.has(url)) continue;
    gone++;
    const de = store.missing.get(url);
    if (!de) store.missing.set(url, today);
    else if (Date.parse(de) < cutoff) { store.first.delete(url); store.missing.delete(url); }
  }

  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({
    since: store.since || today,
    first: Object.fromEntries(store.first),
    missing: Object.fromEntries(store.missing),
  }), "utf8");

  return { baseline, since: store.since || today, today, fresh, gone, tracked: store.first.size };
}

module.exports = { mark };
