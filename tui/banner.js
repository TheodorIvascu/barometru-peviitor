"use strict";
/**
 * Banner: figlet-generated "SOLR DOCTOR" artwork (Star Wars font), read
 * verbatim from banner_wide.txt / banner_stacked.txt at the project root.
 * These files were generated once with figlet and must not be regenerated,
 * re-indented, or trimmed — every character and leading space is
 * figlet-aligned and shifts if touched.
 */
const fs = require("fs");
const path = require("path");
const { c } = require("./theme.js");
const { termWidth, hr } = require("./layout.js");
const caps = require("./caps.js");

const WIDE_PATH = path.join(__dirname, "..", "banner_wide.txt");
const STACKED_PATH = path.join(__dirname, "..", "banner_stacked.txt");
const DOT = caps.chars.dot;

function readArt(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  // Strip exactly one trailing newline (the file's terminator), nothing else,
  // so every remaining character/space is preserved as generated.
  if (raw.endsWith("\r\n")) raw = raw.slice(0, -2);
  else if (raw.endsWith("\n")) raw = raw.slice(0, -1);
  return raw.split(/\r?\n/);
}

function artWidth(lines) {
  return lines.reduce((m, l) => Math.max(m, l.length), 0);
}

/** Pick which pre-rendered art fits `width`, or null for the plain fallback. */
function pickArt(width) {
  if (width >= 118) {
    const lines = readArt(WIDE_PATH);
    if (lines) return lines;
  }
  if (width >= 70) {
    const lines = readArt(STACKED_PATH);
    if (lines) return lines;
  }
  return null;
}

function renderBanner(state) {
  const width = termWidth();
  const accent = (s) => c.brightCyan(s);
  const out = [];

  const art = pickArt(width);
  if (art) {
    const w = artWidth(art);
    for (const l of art) out.push(accent(l));
    out.push(c.dim("made by The0".padStart(w)));
  } else {
    out.push(accent(c.bold("SOLR DOCTOR")));
    out.push(c.dim(hr(Math.min(width, 40))));
    out.push(c.dim("made by The0"));
  }
  out.push("");

  let status;
  if (state.checking && state.live === null) {
    status = c.yellow(DOT + " checking");
  } else if (state.live) {
    status = c.green(DOT + " live");
  } else {
    status = c.red(DOT + " stale / unreachable");
  }
  const urlLine = c.gray(state.solrUrl || "") + "   " + status;
  out.push(urlLine);
  out.push(c.gray(hr(width)));
  return out;
}

module.exports = { renderBanner };
