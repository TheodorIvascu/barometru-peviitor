"use strict";
/**
 * SOLR DOCTOR - web server.
 * Serves the UI from /public and the JSON API from server/api.js.
 * Everything is read-only except POST /api/normalize, which requires {confirm:true}.
 */
require(require("path").join(__dirname, "..", "lib", "env.js")).load();
const http = require("http");
const fs = require("fs");
const path = require("path");
const api = require(path.join(__dirname, "api.js"));
const actions = require(path.join(__dirname, "actions.js"));
const jobs = require(path.join(__dirname, "jobs.js"));
const pipeline = require(path.join(__dirname, "pipeline.js"));
const auth = require(path.join(__dirname, "auth.js"));

// production Solr is the source of truth and is READ-ONLY here; lib/solr.js
// refuses every write, so nothing this tool does can alter peviitor.ro
process.env.SOLR_BASE = process.env.SOLR_BASE || "https://solr.peviitor.ro/solr";

const PORT = Number(process.env.PORT) || 7777;
const PUBLIC = path.join(__dirname, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const ROUTES = {
  "GET /api/auth": async ({ req }) => ({ status: 200, body: auth.status(req) }),
  "GET /api/health": api.getHealth,
  "GET /api/overview": api.getOverview,
  "GET /api/fields": api.getFields,
  "GET /api/warnings": api.getWarnings,
  "GET /api/locations": api.getLocations,
  "GET /api/locations/proposed": api.getLocationsProposed,
  "GET /api/companies": api.getCompanies,
  "GET /api/salary": api.getSalary,
  "GET /api/complete": api.getComplete,
  "GET /api/links": api.getLinks,
  "GET /api/occupations": api.getOccupations,
  "GET /api/tips": api.getTips,
  "POST /api/chat": api.postChat,
  "POST /api/chat/stream": api.postChatStream,
  "GET /api/action/status": actions.getActionStatus,
  "GET /api/checks": jobs.getChecks,
  "GET /api/jobs": jobs.getJobs,
  "GET /api/top": jobs.getTop,
  "POST /api/materialize": jobs.postMaterialize,
  "GET /api/materialize/status": jobs.getMaterializeStatus,
  "POST /api/classify": pipeline.postClassify,
  "POST /api/pipeline": pipeline.postPipeline,
  "GET /api/pipeline/status": pipeline.getPipelineStatus,
  "GET /api/summary": pipeline.getSummary,
  "POST /api/peviitor/open": pipeline.postPeviitorOpen,
  "GET /api/sources": pipeline.getSources,
  "POST /api/sources/diagnose": pipeline.postSourcesDiagnose,
  "GET /api/ai": pipeline.getAiRouting,
  "POST /api/ai/locations": pipeline.postAiLocations,
  "GET /api/ai/locations": pipeline.getAiLocations,
  "POST /api/cor/ai": pipeline.postCorAi,
  "POST /api/cor": pipeline.postCor,
  "GET /api/cor": pipeline.getCor,
  "GET /api/parity": pipeline.getParity,
  "GET /api/parity/job": pipeline.getParityJob,
  "POST /api/judge": jobs.postJudge,
  "GET /api/judge/status": jobs.getJudgeStatus,
  "POST /api/judge/override": jobs.postJudgeOverride,
};

function send(res, code, body, headers) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, headers || {}));
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({ __bad: true }); } });
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: "forbidden" });      // no path traversal
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: "not found: " + rel });
    send(res, 200, buf, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();

  const url = new URL(req.url, "http://localhost");
  // login page, session cookie and logout all live in auth.js; nothing else is
  // served until it says so
  if (!(await auth.gate(req, res, url))) return;
  const key = req.method + " " + url.pathname;
  const handler = ROUTES[key];

  try {
    if (!handler) {
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);
      return send(res, 404, { error: "no such endpoint: " + key });
    }
    const body = req.method === "POST" ? await readBody(req) : {};
    if (body.__bad) return send(res, 400, { error: "body is not valid JSON" });

    const query = Object.fromEntries(url.searchParams.entries());
    const out = await handler({ query, body, req, res });
    if (out && out.__raw) return;   // handler streamed and closed the socket itself
    // handlers answer as {status, body}; the UI expects the payload itself
    const wrapped = out && typeof out === "object" && "status" in out && "body" in out;
    const code = wrapped ? out.status : (out && out.__status) || 200;
    const payload = wrapped ? out.body : out;
    send(res, code, payload);
    console.log(`${new Date().toISOString().slice(11, 19)}  ${code}  ${key}  ${Date.now() - started}ms`);
  } catch (e) {
    console.error(`ERROR ${key}: ${e.stack || e.message}`);
    send(res, 500, { error: String(e.message).slice(0, 300) });
  }
});

server.listen(PORT, () => {
  // The analysis runs itself: once at startup, then an hourly check that only
  // does work if the cache is more than a day old. The button in the sidebar
  // is there to force it early, not because anything depends on it.
  const sch = pipeline.startSchedule();
  console.log("analiza: automata, o data pe zi (verificare la fiecare "
    + Math.round(sch.everyMs / 60000) + " min)");
  console.log("BAROMETRU  ->  http://localhost:" + PORT);
  console.log("acces: " + auth.describe());
  console.log("read-only, except POST /api/normalize which needs {confirm:true}");
});
