"use strict";
/** Terminal chart primitives: horizontal bars only (no stacked bars, no legends). */
const { c } = require("./theme.js");
const { visLen } = require("./layout.js");
const caps = require("./caps.js");

const BLOCK = caps.chars.block;
const LIGHT = caps.chars.light;

function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
  return Number(n).toLocaleString("en-US");
}

/**
 * Horizontal bar chart.
 * items: [{label, count}], width: total columns available.
 * colorFn(item,i) -> color name fn, defaults cyan
 */
function barChart(items, width, opts = {}) {
  if (!items || items.length === 0) return [c.dim("  (no data)")];
  items = items.map((i) => ({ ...i, label: caps.asciiSafe(String(i.label)) }));
  const max = Math.max(...items.map((i) => i.count || 0), 1);
  const labelW = Math.min(Math.max(...items.map((i) => visLen(String(i.label)))), Math.floor(width * 0.35), 28);
  const countW = Math.max(...items.map((i) => fmtNum(i.count).length), 4);
  const barW = Math.max(width - labelW - countW - 4, 4);
  const color = opts.color || c.cyan;
  return items.map((it) => {
    const label = String(it.label).slice(0, labelW).padEnd(labelW);
    const frac = (it.count || 0) / max;
    const filled = Math.max(0, Math.round(frac * barW));
    const bar = color(BLOCK.repeat(filled)) + " ".repeat(barW - filled);
    const count = fmtNum(it.count).padStart(countW);
    return `${c.dim(label)} ${bar} ${count}`;
  });
}

/** Severity color for a 0-100 percentage: ok (green) / warn (yellow) / bad (red). */
function severityColor(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return c.gray;
  if (pct >= 95) return c.green;
  if (pct >= 80) return c.yellow;
  return c.red;
}
function severityLabel(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return "n/a";
  if (pct >= 95) return "ok";
  if (pct >= 80) return "warn";
  return "bad";
}

/** A single horizontal bar for one 0-100 percentage value, colored by severity. */
function pctBar(pct, width, colorFn) {
  const w = Math.max(4, width);
  const p = Math.max(0, Math.min(100, pct || 0));
  const filled = Math.round((p / 100) * w);
  const col = colorFn || severityColor(pct);
  return col(BLOCK.repeat(filled)) + c.dim(LIGHT.repeat(Math.max(0, w - filled)));
}

module.exports = { barChart, fmtNum, pctBar, severityColor, severityLabel };
