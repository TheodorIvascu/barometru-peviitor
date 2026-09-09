"use strict";
/**
 * Sondă pe adresele anunțurilor, pe eșantion.
 *
 * 88.000 de cereri pe zi sunt mai mult decât ar trebui să trimită o găzduire
 * gratuită și mai mult decât merită site-urile extrase. Deci: un eșantion de
 * mărime fixă pentru fiecare sursă, același de la o zi la alta (ales după un
 * hash al adresei, nu la întâmplare), ca proporția per sursă să fie comparabilă
 * în timp.
 *
 * Rezultatul are patru stări, nu două:
 *   dead         404 sau 410, pagina nu mai există și nici nu va reveni
 *   error        alt cod 4xx sau 5xx: 403 interzis, 500 server picat, 503 etc.
 *                Anunțul poate exista, dar cititorul nu ajunge la el.
 *   ok           2xx sau 3xx
 *   unreachable  expirare, DNS sau conexiune refuzată; nu spune nimic despre anunț
 *
 * Codul numeric se păstrează, ca lista să poată fi dusă la cel care repară.
 */

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function classify(status) {
  if (status === 404 || status === 410) return "dead";
  if (status >= 400) return "error";
  return "ok";
}

async function probeOne(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "GET", redirect: "follow", signal: ctl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; barometru-peviitor/2.0; +https://peviitor.ro)", "Accept": "text/html,*/*" },
    });
    try { if (r.body) await r.body.cancel(); } catch { /* nu e nevoie */ }
    return { state: classify(r.status), code: r.status };
  } catch (e) {
    const cause = e.cause || {};
    return { state: "unreachable", code: 0, reason: e.name === "AbortError" ? "timeout" : (cause.code || cause.message || e.message) };
  } finally {
    clearTimeout(timer);
  }
}

const emptyHost = () => ({ sampled: 0, dead: 0, error: 0, unreachable: 0, codes: {} });

/**
 * @param jobs  anunțuri îmbogățite; celor din eșantion li se pun e.link și e.linkCode
 * @returns     { byHost, sampled, dead, error, unreachable, codes, perHost, ms }
 */
async function probeLinks(jobs, opts = {}) {
  const perHost = opts.perHost || 15;
  const concurrency = opts.concurrency || 8;
  const timeoutMs = opts.timeoutMs || 8000;
  const t0 = Date.now();

  const byHost = new Map();
  for (const e of jobs) {
    if (e.host === "(url invalid)") continue;
    if (!byHost.has(e.host)) byHost.set(e.host, []);
    byHost.get(e.host).push(e);
  }
  const sample = [];
  for (const list of byHost.values()) {
    list.sort((a, b) => hash(a.url) - hash(b.url));
    for (const e of list.slice(0, perHost)) sample.push(e);
  }

  let i = 0, done = 0;
  const summary = {};
  const worker = async () => {
    for (;;) {
      const e = sample[i++];
      if (!e) return;
      const r = await probeOne(e.url, timeoutMs);
      e.link = r.state;
      e.linkCode = r.code;
      e.linkReason = r.reason || "";
      const s = summary[e.host] || (summary[e.host] = emptyHost());
      s.sampled++;
      if (r.state !== "ok") s[r.state]++;
      if (r.code) s.codes[r.code] = (s.codes[r.code] || 0) + 1;
      done++;
      if (opts.onProgress && done % 50 === 0) opts.onProgress(done, sample.length);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  return { byHost: summary, ...totals(summary), perHost, ms: Date.now() - t0 };
}

function totals(summary) {
  let sampled = 0, dead = 0, error = 0, unreachable = 0;
  const codes = {};
  for (const s of Object.values(summary)) {
    sampled += s.sampled; dead += s.dead; error += s.error; unreachable += s.unreachable;
    for (const [c, n] of Object.entries(s.codes)) codes[c] = (codes[c] || 0) + n;
  }
  return { sampled, dead, error, unreachable, codes };
}

/** reface rezumatul din verdictele deja puse pe anunțuri, fără să mai ceară nimic în rețea */
function linksFromJobs(jobs, perHost) {
  const byHost = {};
  for (const e of jobs) {
    if (!e.link) continue;
    const s = byHost[e.host] || (byHost[e.host] = emptyHost());
    s.sampled++;
    if (e.link !== "ok") s[e.link]++;
    if (e.linkCode) s.codes[e.linkCode] = (s.codes[e.linkCode] || 0) + 1;
  }
  return { byHost, ...totals(byHost), perHost: perHost || 15, ms: 0, reused: true };
}

module.exports = { probeLinks, linksFromJobs };
