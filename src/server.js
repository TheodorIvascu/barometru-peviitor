"use strict";
/**
 * BAROMETRU web server.
 *
 * Three JSON endpoints and a static folder. No POST, no login, no button:
 * the analysis runs itself once at boot and then whenever the last run is
 * older than RUN_MAX_AGE_HOURS. Nothing here can spend money or write to Solr.
 *
 *   GET /api/health   liveness, never touches Solr
 *   GET /api/run      the latest summary, plus progress while a run is going
 *   GET /api/jobs     the rows behind any number: ?check= ?host= ?county= ...
 */
require("./env.js").load();
const http = require("http");
const fs = require("fs");
const path = require("path");
const { ROOT } = require("./env.js");
const runner = require("./run.js");
const { normCounty, freshnessBucket } = require("./stats.js");
const { QUESTIONS, isAffected } = require("./checks.js");
const rows = require("./rows.js");
const QSET = new Map(QUESTIONS.map((q) => [q.id, new Set(q.checks)]));

const PORT = Number(process.env.PORT) || 7777;
const MAX_AGE_MS = (Number(process.env.RUN_MAX_AGE_HOURS) || 22) * 3600000;
// Pe găzduirea de afișare analiza nu rulează aici: o face un GitHub Action,
// iar rezultatul vine ca fișiere atașate la un release. Fără asta, un serviciu
// gratuit ar porni o analiză de câteva minute la fiecare trezire din somn.
const DOAR_AFISAJ = process.env.ANALIZA === "off";
const PUBLIC = path.join(ROOT, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".geojson": "application/geo+json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

// ---- state ------------------------------------------------------------------
const state = { summary: null, source: "none", running: false, progress: null,
  error: null, errorAt: 0, failures: 0, lastAttempt: 0 };

function adopt(loaded, source) {
  if (!loaded) return;
  state.summary = loaded.summary;
  state.source = source;
}

async function runNow(reason) {
  if (state.running) return;
  state.running = true; state.error = null; state.lastAttempt = Date.now();
  console.log(`analiză: pornesc (${reason})`);
  try {
    const out = await runner.run({ log: (step, info) => { state.progress = { step, ...info }; console.log("  " + step.padEnd(10) + JSON.stringify(info)); } });
    adopt(out, "run");
    state.failures = 0;
    console.log(`analiză: gata, ${out.summary.totals.trusted} din ${out.summary.totals.jobs} anunțuri de încredere`);
  } catch (e) {
    state.error = e.message;
    state.errorAt = Date.now();
    state.failures++;
    console.error("analiză: EȘUATĂ (a " + state.failures + "-a oară) " + (e.stack || e.message));
  } finally {
    state.running = false; state.progress = null;
  }
}

function isStale() {
  if (!state.summary || state.source === "seed") return true;
  return Date.now() - Date.parse(state.summary.runAt) > MAX_AGE_MS;
}

const HOUR = 3600000;

/**
 * Cât se așteaptă până la următoarea încercare. O rețea căzută pentru un minut
 * nu trebuie să lase datele vechi o oră întreagă, dar nici nu are rost să
 * insistăm din secundă în secundă dacă Solr chiar e jos: 10 minute, apoi 20,
 * 40, până la o oră.
 */
function retryDelay() {
  if (!state.failures) return HOUR;
  return Math.min(HOUR, 10 * 60000 * Math.pow(2, state.failures - 1));
}

/**
 * În modul afișaj, datele vin din release-ul de pe GitHub. Sincronizarea
 * pornește DUPĂ ce serverul ascultă deja, ca portul să răspundă imediat: o
 * verificare de sănătate care așteaptă o descărcare de 11 MB ar marca pornirea
 * ca eșuată. Se reia periodic, deci un container trezit din somn ia analiza
 * cea mai nouă fără să fie repornit de nimeni.
 */
function startSync() {
  const sync = require("../tools/fetch-latest.js");
  const ruleaza = () => sync.sincronizeaza({ log: (m) => console.log("sincronizare: " + m) })
    .then((r) => { if (r.adus) adopt(runner.loadLatest(), "release"); });
  ruleaza();
  setInterval(ruleaza, 30 * 60000);
}

function startSchedule() {
  if (DOAR_AFISAJ) {
    console.log("analiză: oprită (ANALIZA=off) — datele vin din release");
    startSync();
    return;
  }
  if (isStale()) runNow(state.summary ? "ultima analiză e veche" : "nu există nicio analiză");
  // tick des, decide rar: o gazdă care adoarme containerul nu ajunge niciodată
  // la un temporizator pus pentru mâine
  setInterval(() => {
    if (state.running || !isStale()) return;
    if (Date.now() - state.lastAttempt < retryDelay()) return;
    runNow(state.failures ? "reîncercare după eșec" : "verificare programată");
  }, 5 * 60000);
}

// ---- filters --------------------------------------------------------------------
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[șş]/gi, "s").replace(/[țţ]/gi, "t").toLowerCase().trim();

/**
 * Prima zi a ferestrei de N zile. Ziua în care s-a stabilit linia de plecare
 * este exclusă: atunci tot indexul a primit prima apariție deodată, ceea ce nu
 * înseamnă că a intrat atunci.
 */
function ferestreDe(n) {
  if (!Number.isFinite(n) || n < 1) return null;
  const inc = state.summary && state.summary.incoming;
  const azi = (state.summary && state.summary.runAt || new Date().toISOString()).slice(0, 10);
  const nZile = new Date(Date.parse(azi) - (n - 1) * 86400000).toISOString().slice(0, 10);
  if (!inc || !inc.since) return nZile;
  const dupaReferinta = new Date(Date.parse(inc.since) + 86400000).toISOString().slice(0, 10);
  return nZile > dupaReferinta ? nZile : dupaReferinta;
}

function matches(e, f) {
  if (f.check && !e.issues.includes(f.check)) return false;
  if (f.question) { const set = QSET.get(f.question); if (!set || !e.issues.some((id) => set.has(id))) return false; }
  if (f.trusted && isAffected(e.issues)) return false;
  if (f.neconform && !isAffected(e.issues)) return false;
  if (f.nou && !e.isNew) return false;
  if (f.zile) {                                       // apărute în ultimele N zile
    const de = ferestreDe(Number(f.zile));
    if (!de || !e.firstSeen || e.firstSeen < de) return false;
  }
  if (f.prima) {
    const inc = state.summary && state.summary.incoming;
    if (inc && inc.since && f.prima <= inc.since) return false;   // ziua de referință nu e o zi de intrări
    if (e.firstSeen !== f.prima) return false;
  }
  if (f.host && e.host !== f.host) return false;
  if (f.county && norm(normCounty(e.loc.county)) !== norm(f.county)) return false;
  if (f.locality && e.loc.value !== f.locality) return false;
  if (f.loc) {                                        // placed | foreign | placeholder | gibberish | empty | ambiguous
    const k = e.loc.kind === "fixed" ? (e.loc.county ? "placed" : "ambiguous")
      : e.loc.kind === "international" ? "foreign"
      : e.loc.how === "empty" ? "empty" : e.loc.how === "placeholder" ? "placeholder" : "gibberish";
    if (k !== f.loc) return false;
  }
  if (f.rawloc && e.location.join(", ") !== f.rawloc) return false;
  if (f.place && e.loc.value !== f.place) return false;
  if (f.company && e.cifKey !== f.company) return false;
  if (f.workmode && (e.workmode || "(gol)") !== f.workmode) return false;
  if (f.status && (e.status || "(gol)") !== f.status) return false;
  if (f.title && e.ntitle !== f.title) return false;
  if (f.tag && !e.tags.includes(f.tag)) return false;
  if (f.fresh && freshnessBucket(e.age) !== f.fresh) return false;
  if (f.link && e.link !== f.link) return false;
  if (f.linkbad && e.link !== "dead" && e.link !== "error") return false;
  if (f.q && !e.ntitle.includes(f.q.toLowerCase()) && !e.company.toLowerCase().includes(f.q.toLowerCase())) return false;
  return true;
}

async function getJobs(query) {
  if (!rows.exists()) return { status: 503, body: { error: state.running ? "analiza rulează; rândurile apar când termină" : "analiza nu a rulat încă în acest mediu", running: state.running, progress: state.progress } };
  const page = Math.max(1, Number(query.page) || 1);
  const size = Math.min(200, Math.max(1, Number(query.size) || 50));
  // fișierul e deja sortat descrescător după dată la scriere, deci nu mai
  // sortăm nimic aici și nu ținem în memorie decât pagina cerută
  const found = await rows.page((e) => matches(e, query), (page - 1) * size, size);
  const items = found.items.map((e) => ({
    url: e.url, title: e.title, company: e.company, cif: e.cif, location: e.location, date: e.date, status: e.status,
    workmode: e.workmode, host: e.host, issues: e.issues, loc: e.loc, link: e.link,
    coStatus: e.coStatus, coChecked: e.coChecked, isNew: e.isNew, firstSeen: e.firstSeen, daysHere: e.daysHere,
    linkCode: e.linkCode, linkReason: e.linkReason,
  }));
  return { status: 200, body: { total: found.total, page, size, pages: Math.ceil(found.total / size), items } };
}

// ---- http -----------------------------------------------------------------------
function send(res, code, body, headers) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, headers || {}));
  res.end(data);
}

function serveStatic(res, urlPath) {
  let rel;
  try { rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, ""); } catch { return send(res, 400, { error: "cale invalidă" }); }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: "interzis" });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: "nu există: " + rel });
    const cache = rel.startsWith("vendor/") && !rel.endsWith(".geojson") ? "public, max-age=86400" : "no-cache";
    send(res, 200, buf, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": cache });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method !== "GET") return send(res, 405, { error: "doar GET: BAROMETRU citește, nu scrie" });
  const p = url.pathname;
  try {
    if (p === "/api/health") return send(res, 200, { ok: true, hasRun: !!state.summary, source: state.source,
      running: state.running, mod: DOAR_AFISAJ ? "afisaj" : "complet", randuri: rows.exists(),
      dataAnalizei: state.summary ? state.summary.runAt : null });
    if (p === "/api/run") return send(res, 200, { running: state.running, progress: state.progress,
      error: state.error, errorAt: state.errorAt || null, failures: state.failures,
      source: state.source, summary: state.summary });
    if (p === "/api/jobs") { const out = await getJobs(Object.fromEntries(url.searchParams.entries())); return send(res, out.status, out.body); }
    if (p.startsWith("/api/")) return send(res, 404, { error: "nu există: " + p });
    return serveStatic(res, p);
  } catch (e) {
    console.error("EROARE " + p + ": " + (e.stack || e.message));
    return send(res, 500, { error: String(e.message).slice(0, 200) });
  }
});

server.listen(PORT, () => {
  adopt(runner.loadLatest(), "disk");
  if (!state.summary) adopt(runner.loadSeed(), "seed");
  console.log(`BAROMETRU  http://localhost:${PORT}   (date: ${state.source}${state.summary ? ", din " + state.summary.runAt : ""})`);
  startSchedule();
});
