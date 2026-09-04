"use strict";
/**
 * server/report.js - GET /raport, the printable analysis.
 *
 * A page, not a download. The browser's own print dialog turns it into a PDF,
 * which means no PDF library on the server and no headless browser in the
 * image; it also means the reader gets to choose paper size and whether to
 * keep the backgrounds, which a server-rendered file would decide for them.
 *
 * Everything below the prose is measured. The model writes only the four
 * sections at the top, and its name and the date it wrote them are printed in
 * the footer so nobody has to guess how old the reading is.
 */
const path = require("path");

const ROOT = path.join(__dirname, "..");

const esc = (v) => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const nf = (n) => (n == null ? "" : Number(n).toLocaleString("ro-RO"));
const when = (iso) => (iso ? new Date(iso).toLocaleString("ro-RO") : "necunoscut");

const SEV = { blocant: "grav", avertisment: "avertisment", info: "info", cosmetic: "cosmetic" };

/** the model writes `## Titlu` and paragraphs; nothing else is allowed through */
function prose(text) {
  if (!text) return '<p class="missing">Analiza nu a fost scrisă încă. Se generează la rularea zilnică.</p>';
  const out = [];
  for (const block of String(text).split(/\n{2,}/)) {
    const t = block.trim();
    if (!t) continue;
    if (t.startsWith("##")) out.push("<h2>" + esc(t.replace(/^#+\s*/, "")) + "</h2>");
    else out.push("<p>" + esc(t).replace(/\n/g, " ") + "</p>");
  }
  return out.join("\n");
}

function rulesTable(rules) {
  const rows = rules
    .slice()
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .map((r) => `<tr>
      <td>${esc(r.label)}</td>
      <td>${esc(r.group)}</td>
      <td>${esc(SEV[r.severity] || r.severity)}</td>
      <td class="num">${r.measured ? nf(r.count) : "&mdash;"}</td>
      <td class="num">${r.measured && r.pct != null ? r.pct + "%" : "&mdash;"}</td>
    </tr>`).join("");
  return `<table>
    <thead><tr><th>Verificare</th><th>Grup</th><th>Gravitate</th><th class="num">Joburi</th><th class="num">Din total</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function sourcesTable(rows) {
  if (!rows.length) return '<p class="missing">Gruparea pe surse nu a rulat încă.</p>';
  const body = rows.map((s) => `<tr>
    <td>${esc(s.host)}</td>
    <td class="num">${nf(s.jobs)}</td>
    <td class="num">${nf(s.affected)}</td>
    <td class="num">${s.affectedPct}%</td>
    <td>${esc((s.top || []).slice(0, 2).map((t) => t.label).join("; "))}</td>
  </tr>`).join("");
  return `<table>
    <thead><tr><th>Sursă</th><th class="num">Joburi</th><th class="num">Afectate</th><th class="num">Rata</th><th>Principalele defecte</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

function corSection(cor) {
  if (!cor) return '<p class="missing">Potrivirea COR nu a rulat încă.</p>';
  const top = (cor.top || []).map((o) => `<tr>
    <td>${esc(o.label || o.name || o.title || "")}</td>
    <td class="num">${nf(o.jobs != null ? o.jobs : o.n)}</td>
  </tr>`).join("");
  return `<p>Din cele ${nf(cor.distinctTitles)} de titluri distincte, ${cor.matchedPct}% dintre joburi
    (${nf(cor.matchedJobs)}) primesc un cod din clasificarea oficială a ocupațiilor.
    Pentru ${nf(cor.ambiguousJobs)} titlul se potrivește cu mai multe ocupații deodată,
    deci codul nu poate fi ales cu siguranță.</p>
  ${top ? `<table><thead><tr><th>Ocupație</th><th class="num">Joburi</th></tr></thead><tbody>${top}</tbody></table>` : ""}`;
}

async function getReport() {
  const report = require(path.join(ROOT, "lib", "report.js"));
  const t = await report.tables();
  const r = report.read();

  const html = `<!DOCTYPE html>
<html lang="ro"><head><meta charset="UTF-8">
<title>Barometru &middot; raport de calitate a datelor</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font: 11pt/1.55 Georgia, "Times New Roman", serif;
    color: #111; background: #fff; margin: 0 auto; max-width: 190mm; padding: 24px;
  }
  header { border-bottom: 2px solid #111; padding-bottom: 12px; margin-bottom: 26px; }
  header h1 { font-size: 20pt; margin: 0 0 4px; letter-spacing: .01em; }
  header .meta { font: 9pt/1.5 ui-monospace, Consolas, monospace; color: #555; }
  .figures { display: flex; gap: 28px; margin: 22px 0 30px; }
  .figure { border-left: 3px solid #111; padding-left: 12px; }
  .figure b { display: block; font: 22pt/1 ui-monospace, Consolas, monospace; }
  .figure span { font-size: 9pt; color: #555; }
  h2 { font-size: 13pt; margin: 26px 0 8px; page-break-after: avoid; }
  p { margin: 0 0 10px; text-align: justify; }
  .missing { color: #777; font-style: italic; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0 22px; font-size: 9.5pt; page-break-inside: auto; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { border-bottom: 1.5px solid #111; font-weight: 700; }
  td.num, th.num { text-align: right; font-family: ui-monospace, Consolas, monospace; white-space: nowrap; }
  tr { page-break-inside: avoid; }
  footer { margin-top: 34px; padding-top: 12px; border-top: 1px solid #ccc; font-size: 8.5pt; color: #666; }
  .print { position: fixed; top: 16px; right: 16px; font-family: system-ui, sans-serif;
           font-size: 13px; padding: 9px 16px; border: 1px solid #111; background: #fff; cursor: pointer; }
  @media print { .print { display: none; } body { padding: 0; } }
</style></head>
<body>
<button class="print" onclick="window.print()">Salvează ca PDF</button>

<header>
  <h1>Starea datelor peviitor.ro</h1>
  <div class="meta">raport generat ${esc(when(new Date().toISOString()))} &middot; măsurători din ${esc(when(t.at))}</div>
</header>

<div class="figures">
  <div class="figure"><b>${nf(t.total)}</b><span>joburi în index</span></div>
  <div class="figure"><b>${t.score == null ? "&mdash;" : t.score}</b><span>scor de sănătate (0&ndash;100)</span></div>
  <div class="figure"><b>${t.measured}/${t.ofRules}</b><span>verificări rulate</span></div>
</div>

${prose(r && r.text)}

<h2>Toate verificările</h2>
${rulesTable(t.rules)}

<h2>Defectele pe sursă</h2>
<p>Rata este cât din joburile acelei surse au cel puțin un defect. O rată mare pe o
sursă mare înseamnă că o singură reparație curăță mii de rânduri.</p>
${sourcesTable(t.sources)}

<h2>Acoperirea clasificării ocupațiilor</h2>
${corSection(t.cor)}

<footer>
  Textul de analiză a fost scris de ${esc((r && r.model) || "model")} pe ${esc(when(r && r.at))}.
  Toate cifrele și tabelele sunt măsurate direct din indexul de producție, în regim de citire.
  Barometrul găsește probleme; nu modifică datele.
</footer>
</body></html>`;

  return { status: 200, body: html, html: true };
}

module.exports = { getReport };
