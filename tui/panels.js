"use strict";
/**
 * Three screens, one shared data bundle (tui/data.js's loadAll()):
 *   1. VALIDATION - the centerpiece: one row per field, filled% / valid% /
 *      concrete problems, horizontal bars only, colored by severity.
 *   2. STATS      - a compact strip of headline numbers.
 *   3. WARNINGS   - the concrete offenders behind the validation numbers,
 *      each with a count and real examples.
 */
const { c } = require("./theme.js");
const { termHeight, box, visLen } = require("./layout.js");
const { fmtNum, pctBar, severityColor } = require("./charts.js");
const { VALIDATION_FIELDS } = require("./validate.js");
const caps = require("./caps.js");

function naLine(msg) {
  return c.dim(msg || "n/a");
}

function sourceTag(entry) {
  if (!entry) return c.dim("[loading...]");
  if (entry.source === "analytics") return c.green("[live: analytics]");
  if (entry.source === "solr") {
    return entry.analyticsTimedOut ? c.yellow("[live: solr fallback - analytics timed out]") : c.yellow("[live: solr]");
  }
  if (entry.source === "error") return c.red("[error: " + (entry.error || "unknown") + "]");
  return c.dim("[loading...]");
}

function panelLoading(name) {
  return [c.dim("loading " + name + "...")];
}

/** truncate plain text to `w` visible columns with an ellipsis, keeping colored siblings intact. */
function truncatePlain(s, w) {
  if (visLen(s) <= w) return s;
  const ellipsis = caps.unicode ? "…" : "...";
  const cut = Math.max(0, w - ellipsis.length);
  return s.slice(0, cut) + ellipsis;
}

// Top N problem labels for a field, sorted by how many docs they hit.
function topProblems(problemsMap, n) {
  if (!problemsMap || problemsMap.size === 0) return [];
  return [...problemsMap.entries()]
    .filter(([label]) => label !== "empty")
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, n);
}

// ---------- 1. VALIDATION ----------
function fieldTable(vdata, width) {
  const lines = [];
  const total = vdata.total || 0;
  const innerW = Math.max(width - 4, 20);

  const fieldW = 10;
  let barW = 10;
  let pctW = 5;
  let block = barW + 1 + pctW;
  let fixed = fieldW + 1 + block + 1 + block + 1;
  let problemsW = innerW - fixed;
  if (problemsW < 12) {
    barW = 6;
    pctW = 4;
    block = barW + 1 + pctW;
    fixed = fieldW + 1 + block + 1 + block + 1;
    problemsW = Math.max(8, innerW - fixed);
  }

  const header =
    c.dim("field".padEnd(fieldW)) +
    " " +
    c.dim("filled".padEnd(block)) +
    " " +
    c.dim("valid".padEnd(block)) +
    " " +
    c.dim("problems");
  lines.push(header);

  for (const field of VALIDATION_FIELDS) {
    const fstat = vdata.fields[field] || { filled: 0, valid: 0 };
    const filledPct = total ? Math.round((fstat.filled / total) * 1000) / 10 : 0;
    const validPct = total ? Math.round((fstat.valid / total) * 1000) / 10 : 0;

    const labelCol = severityColor(validPct)(field.padEnd(fieldW));
    const filledCol = pctBar(filledPct, barW, c.cyan) + " " + c.dim((filledPct + "%").padStart(pctW));
    const validCol = pctBar(validPct, barW) + " " + (validPct + "%").padStart(pctW);

    const probs = topProblems(vdata.problems[field], 3);
    let problemsTxt = probs.length ? probs.map(([label, info]) => fmtNum(info.count) + " " + label).join(caps.unicode ? "  •  " : "  |  ") : c.dim("-");
    problemsTxt = truncatePlain(problemsTxt, problemsW);

    lines.push(labelCol + " " + filledCol + " " + validCol + " " + problemsTxt);
  }
  return lines;
}

function validationPanel(bundle, width) {
  if (!bundle) return panelLoading("validation");
  const entry = bundle.validation;
  if (!entry || entry.source === "error") return [sourceTag(entry), ...(entry && entry.error ? [c.red(entry.error)] : [])];
  const d = entry.data;
  if (!d) return panelLoading("validation");
  const lines = [];
  lines.push(sourceTag(entry) + c.dim("   " + fmtNum(d.total) + " docs scanned in " + d.scanMs + "ms"));
  if (d.companyIdsAvailable === false) lines.push(c.yellow("company core unreachable - cif/company existence checks skipped"));
  lines.push("");
  lines.push(...fieldTable(d, width));
  return lines;
}

// ---------- 2. STATS ----------
function statRow(label, value, width) {
  const v = value === null || value === undefined ? naLine() : c.brightWhite(String(value));
  return "  " + c.dim(label.padEnd(26)) + v;
}

function statsPanel(bundle, width) {
  if (!bundle) return panelLoading("stats");
  const ov = bundle.overview || {};
  const sal = bundle.salaryStats || {};
  const val = bundle.validation || {};
  const od = ov.data || {};
  const sd = sal.data || {};
  const vd = val.data || {};

  const lines = [];
  lines.push(sourceTag(ov) + c.dim("  overview") + "   " + sourceTag(sal) + c.dim("  salary"));
  lines.push("");
  lines.push(statRow("total jobs", fmtNum(od.jobs ?? vd.total)));
  lines.push(statRow("companies", od.companies == null ? null : fmtNum(od.companies)));
  lines.push("");
  lines.push(c.bold("  salary (RON/month, parsed - coverage is genuinely low)"));
  lines.push(statRow("avg salary", sd.avg == null ? null : fmtNum(sd.avg) + " RON"));
  lines.push(statRow("median salary", sd.median == null ? null : fmtNum(sd.median) + " RON"));
  lines.push(statRow("min / max salary", sd.min == null || sd.max == null ? null : fmtNum(sd.min) + " / " + fmtNum(sd.max) + " RON"));
  lines.push(statRow("salary coverage", sd.pct == null ? null : sd.pct + "%"));
  lines.push("");
  lines.push(c.bold("  spread"));
  lines.push(statRow("distinct localities", od.distinctLocalities == null ? null : fmtNum(od.distinctLocalities)));
  lines.push(statRow("distinct source domains", vd.domains ? fmtNum(vd.domains.size) : null));
  return lines;
}

// ---------- 3. WARNINGS ----------
function offenderBlock(label, entry, width) {
  const lines = [];
  const labelCol = label.length >= 24 ? label + " " : label.padEnd(24);
  if (!entry) {
    lines.push(c.dim(labelCol) + naLine());
    return lines;
  }
  // A missing/zero count here is good news (no offenders found), not an
  // unknown - only a genuinely unavailable validation pass says "n/a".
  const count = entry.count || 0;
  const color = count > 0 ? c.yellow : c.green;
  lines.push(color(labelCol) + c.brightWhite(fmtNum(count)));
  for (const ex of (entry.examples || []).slice(0, 3)) {
    lines.push("    " + c.dim(caps.asciiSafe(String(ex))));
  }
  return lines;
}

function warningsPanel(bundle, width) {
  if (!bundle) return panelLoading("warnings");
  const val = bundle.validation || {};
  const warn = bundle.warnings || {};
  const vd = val.data || {};
  const wd = warn.data || {};
  const lines = [];
  lines.push(sourceTag(val) + c.dim("  validation-derived   ") + sourceTag(warn) + c.dim("  analytics"));
  lines.push("");

  // val.source === "error" means the whole validation pass is unavailable
  // (true "n/a"); otherwise a label with no matches simply means zero
  // offenders were found, which offenderBlock renders as a real "0".
  const haveValidation = val.source !== "error";
  const problems = vd.problems || {};
  const getProblem = (field, label) => (haveValidation ? (problems[field] && problems[field].get(label)) || { count: 0, examples: [] } : null);
  const titleAllCaps = getProblem("title", "ALL CAPS");
  const cifZero = getProblem("cif", "cif = 0");
  const cifOrphan = getProblem("cif", "orphan (not in company core)");
  const workmodeBad = getProblem("workmode", "not remote|on-site|hybrid");

  lines.push(...offenderBlock("SHOUTING titles", titleAllCaps, width));
  lines.push("");

  const dupList = wd.duplicateTitles || [];
  const dupEntry = warn.source !== "error" ? { count: dupList.length, examples: dupList.slice(0, 3).map((x) => x.title + " (x" + x.count + ")") } : null;
  lines.push(...offenderBlock("duplicate titles", dupEntry, width));
  lines.push("");

  lines.push(...offenderBlock("cif = 0", cifZero, width));
  lines.push("");

  lines.push(...offenderBlock("orphan cif (not in company core)", cifOrphan, width));
  lines.push("");

  lines.push(...offenderBlock("invalid workmode", workmodeBad, width));

  return lines;
}

const RENDERERS = { 1: validationPanel, 2: statsPanel, 3: warningsPanel };
const TITLES = { 1: "FIELD VALIDATION", 2: "STATS", 3: "WARNINGS" };

function renderPanel(tab, bundle, width) {
  const body = RENDERERS[tab](bundle, width);
  return box(TITLES[tab], body, width, c.gray);
}

module.exports = { renderPanel };
