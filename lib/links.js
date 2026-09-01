"use strict";
/**
 * Job-link checker.
 *
 * Politeness rules, because these are other people's servers:
 *   - one rate limiter PER HOST, so 109 links on tremend.com are spread out
 *     instead of arriving as a burst
 *   - HEAD first, GET only if HEAD is rejected (many sites answer 405)
 *   - results cached on disk, so a link is checked once
 *   - honours Retry-After on 429 (handled inside fetchRetry)
 */
const fs = require("fs");
const path = require("path");
const { RateLimiter, fetchRetry } = require(path.join(__dirname, "ratelimit.js"));

const CACHE = path.join(__dirname, "..", "cache", "links.json");
const UA = "peviitor-doctor/1.0 (+link health check)";

const hosts = new Map();
function limiterFor(host, perSecond, concurrency) {
  if (!hosts.has(host)) hosts.set(host, new RateLimiter(perSecond, concurrency));
  return hosts.get(host);
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return {}; }
}
function saveCache(c) {
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(c, null, 1));
  } catch {}
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

function classify(status) {
  if (status === null) return "unreachable";
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "blocked";     // alive, refuses bots
  if (status === 404 || status === 410) return "dead";
  if (status === 429) return "ratelimited";
  if (status >= 500) return "server-error";
  return "other";
}

async function checkOne(url, cfg) {
  const host = hostOf(url);
  if (!host) return { url, status: null, result: "invalid-url" };
  const lim = limiterFor(host, cfg.perSecondPerHost, cfg.concurrencyPerHost);
  const t = Date.now();
  try {
    let res = await lim.run(() => fetchRetry(url, { method: "HEAD", redirect: "follow", headers: { "User-Agent": UA } }, { retries: 1, timeoutMs: cfg.timeoutMs }));
    if (res.status === 405 || res.status === 501) {
      res = await lim.run(() => fetchRetry(url, { method: "GET", redirect: "follow", headers: { "User-Agent": UA, Range: "bytes=0-0" } }, { retries: 1, timeoutMs: cfg.timeoutMs }));
    }
    return { url, host, status: res.status, result: classify(res.status), ms: Date.now() - t, checked: new Date().toISOString().slice(0, 10) };
  } catch (e) {
    return { url, host, status: null, result: "unreachable", error: String(e.message).slice(0, 60), ms: Date.now() - t, checked: new Date().toISOString().slice(0, 10) };
  }
}

/**
 * @param {string[]} urls
 * @param {object} opts perSecondPerHost, concurrencyPerHost, timeoutMs, useCache, onProgress
 */
async function check(urls, opts = {}) {
  const cfg = {
    perSecondPerHost: opts.perSecondPerHost || 2,
    concurrencyPerHost: opts.concurrencyPerHost || 2,
    timeoutMs: opts.timeoutMs || 12000,
  };
  const useCache = opts.useCache !== false;
  const cache = useCache ? loadCache() : {};
  const out = {};
  const todo = [];
  for (const u of [...new Set(urls)]) {
    if (useCache && cache[u]) out[u] = cache[u];
    else todo.push(u);
  }

  let done = 0;
  const results = await Promise.all(todo.map(async (u) => {
    const r = await checkOne(u, cfg);
    done++;
    opts.onProgress && opts.onProgress(done, todo.length, r);
    return r;
  }));
  for (const r of results) { out[r.url] = r; if (useCache) cache[r.url] = r; }
  if (useCache) saveCache(cache);

  const summary = { total: Object.keys(out).length, byResult: {}, byHost: {} };
  for (const r of Object.values(out)) {
    summary.byResult[r.result] = (summary.byResult[r.result] || 0) + 1;
    if (!r.host) continue;
    summary.byHost[r.host] = summary.byHost[r.host] || { ok: 0, dead: 0, other: 0 };
    if (r.result === "ok") summary.byHost[r.host].ok++;
    else if (r.result === "dead") summary.byHost[r.host].dead++;
    else summary.byHost[r.host].other++;
  }
  return { results: out, summary };
}

module.exports = { check, checkOne, hostOf, classify };
