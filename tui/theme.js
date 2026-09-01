"use strict";
/** Raw ANSI theme. Respects NO_COLOR and console color-capability detection. */
const caps = require("./caps.js");

const NO_COLOR = !!process.env.NO_COLOR || !caps.color;

const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
  brightBlue: 94,
  brightMagenta: 95,
  brightCyan: 96,
  brightWhite: 97,
  bgBlack: 40,
  bgRed: 41,
  bgGreen: 42,
  bgYellow: 43,
  bgBlue: 44,
  bgMagenta: 45,
  bgCyan: 46,
  bgWhite: 47,
};

function esc(code) {
  return "\x1b[" + code + "m";
}

/** wrap(text, "cyan", "bold") -> colored string, or plain text if NO_COLOR */
function wrap(text, ...styles) {
  if (NO_COLOR || styles.length === 0) return text;
  const codes = styles.filter((s) => CODES[s] !== undefined).map(esc).join("");
  if (!codes) return text;
  return codes + text + esc(CODES.reset);
}

const c = {
  reset: () => (NO_COLOR ? "" : esc(CODES.reset)),
  bold: (s) => wrap(s, "bold"),
  dim: (s) => wrap(s, "dim"),
  red: (s) => wrap(s, "red"),
  green: (s) => wrap(s, "green"),
  yellow: (s) => wrap(s, "yellow"),
  blue: (s) => wrap(s, "blue"),
  magenta: (s) => wrap(s, "magenta"),
  cyan: (s) => wrap(s, "cyan"),
  white: (s) => wrap(s, "white"),
  gray: (s) => wrap(s, "gray"),
  brightRed: (s) => wrap(s, "brightRed"),
  brightGreen: (s) => wrap(s, "brightGreen"),
  brightYellow: (s) => wrap(s, "brightYellow"),
  brightBlue: (s) => wrap(s, "brightBlue"),
  brightMagenta: (s) => wrap(s, "brightMagenta"),
  brightCyan: (s) => wrap(s, "brightCyan"),
  brightWhite: (s) => wrap(s, "brightWhite"),
  bgBlue: (s) => wrap(s, "bgBlue"),
  invert: (s) => wrap(s, "bold"),
  wrap,
};

module.exports = { c, NO_COLOR, CODES, esc };
