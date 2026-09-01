"use strict";
/** Terminal size + box-drawing + ANSI-aware string helpers. */
const caps = require("./caps.js");

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s) {
  return String(s).replace(ANSI_RE, "");
}

function visLen(s) {
  return stripAnsi(s).length;
}

function termWidth() {
  const w = process.stdout.columns;
  return w && w > 0 ? w : 80;
}

function termHeight() {
  const h = process.stdout.rows;
  return h && h > 0 ? h : 24;
}

/** pad/truncate a (possibly colored) string to exactly `width` visible cols */
function fit(s, width) {
  const len = visLen(s);
  if (len === width) return s;
  if (len < width) return s + " ".repeat(width - len);
  // truncate: walk plain text since ansi codes complicate slicing; strip for safety
  const plain = stripAnsi(s);
  const ellipsis = caps.unicode ? "…" : "...";
  const cut = Math.max(0, width - ellipsis.length);
  return width > 0 ? plain.slice(0, cut) + ellipsis.slice(0, width) : "";
}

function padStartVis(s, width) {
  const len = visLen(s);
  return len >= width ? s : " ".repeat(width - len) + s;
}

const BOX = caps.chars;

/** draw a bordered panel: title + content lines, exact `width` columns wide */
function box(title, lines, width, colorFn) {
  const col = colorFn || ((x) => x);
  const innerW = Math.max(width - 4, 4);
  const out = [];
  const titleTxt = title ? " " + title + " " : "";
  const dashes = Math.max(width - 2 - visLen(titleTxt), 0);
  out.push(col(BOX.tl) + col(titleTxt) + col(BOX.h.repeat(dashes)) + col(BOX.tr));
  for (const l of lines) {
    out.push(col(BOX.v) + " " + fit(l, innerW) + " " + col(BOX.v));
  }
  out.push(col(BOX.bl) + col(BOX.h.repeat(width - 2)) + col(BOX.br));
  return out;
}

function hr(width, ch) {
  return (ch || BOX.h).repeat(Math.max(width, 0));
}

module.exports = { stripAnsi, visLen, termWidth, termHeight, fit, padStartVis, box, hr, BOX };
