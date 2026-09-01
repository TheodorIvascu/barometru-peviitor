"use strict";
/**
 * Console capability detection: unicode/box-drawing support and color support.
 * Must work correctly in classic cmd.exe and powershell.exe, not just Windows
 * Terminal — those legacy hosts often sit on codepage 437/852 where UTF-8
 * output (box-drawing chars, Romanian diacritics) turns to mojibake.
 *
 * Strategy:
 *  - DOCTOR_ASCII=1 / DOCTOR_UNICODE=1 force the choice (escape hatch).
 *  - Non-Windows: assume UTF-8 (true for effectively all modern terminals).
 *  - Windows Terminal (WT_SESSION set): always UTF-8 safe regardless of the
 *    legacy console codepage, because WT decodes bytes as UTF-8 itself.
 *  - Plain conhost (cmd.exe / powershell.exe): try `chcp 65001` to switch the
 *    console's active codepage to UTF-8. If that succeeds we use unicode
 *    glyphs; the original codepage is restored on exit. If chcp is
 *    unavailable/fails for any reason, we fall back to a pure-ASCII glyph
 *    set (+ - | = # * .) so borders/bars never render as garbage.
 *  - Color: Node auto-detects VT support on win32 via hasColors(); we also
 *    honor NO_COLOR and never emit ANSI when stdout isn't a TTY (keeps piped
 *    output free of escape-code noise).
 */
const { execSync } = require("child_process");

const FORCE_ASCII = process.env.DOCTOR_ASCII === "1";
const FORCE_UNICODE = process.env.DOCTOR_UNICODE === "1";

let originalCodepage = null;
let switchedCodepage = false;

function detectUnicodeWindows() {
  if (process.env.WT_SESSION || process.env.WT_PROFILE_ID) return true; // Windows Terminal: always UTF-8 safe
  try {
    const out = execSync("chcp", { encoding: "utf8" });
    const m = out.match(/(\d+)/);
    if (m) originalCodepage = m[1];
    execSync("chcp 65001", { stdio: "ignore" });
    switchedCodepage = true;
    return true;
  } catch (e) {
    return false; // chcp unavailable/blocked -> stay ASCII-safe
  }
}

function detectUnicode() {
  if (FORCE_ASCII) return false;
  if (FORCE_UNICODE) return true;
  if (process.platform !== "win32") return true;
  return detectUnicodeWindows();
}

// VT/ANSI escape support (cursor movement, alt-screen, clear, color) — this
// is a single underlying capability. NO_COLOR must only suppress *color*
// codes, not the ability to move the cursor/clear/repaint; conflating the
// two made piped/redirected output re-print the whole screen on every
// spinner tick instead of just not coloring text.
function detectVT() {
  if (!process.stdout.isTTY) return false;
  try {
    if (typeof process.stdout.hasColors === "function") return process.stdout.hasColors();
  } catch {}
  return process.platform !== "win32";
}

const unicode = detectUnicode();
const vt = detectVT();
// `color`: safe to emit color escapes (respects NO_COLOR).
const color = vt && !process.env.NO_COLOR;
// `screen`: safe to emit cursor/alt-screen/clear escapes (repaint in place).
// Independent of NO_COLOR — a NO_COLOR user on a real TTY still gets a
// flicker-free redraw, just without color.
const screen = vt;

const chars = unicode
  ? {
      tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", ml: "├", mr: "┤",
      block: "█", light: "░", bullet: "■", dot: "●",
      spark: " ▁▂▃▄▅▆▇█",
      spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    }
  : {
      tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", ml: "+", mr: "+",
      block: "#", light: ".", bullet: "*", dot: "o",
      spark: " .:-=+*#%@",
      spinner: ["|", "/", "-", "\\"],
    };

// Best-effort transliteration so Romanian diacritics stay readable instead of
// turning into mojibake on codepages that can't represent them.
const DIACRITICS = {
  ă: "a", â: "a", î: "i", ș: "s", ş: "s", ț: "t", ţ: "t",
  Ă: "A", Â: "A", Î: "I", Ș: "S", Ş: "S", Ț: "T", Ţ: "T",
};
function asciiSafe(str) {
  if (unicode || str === null || str === undefined) return str;
  return String(str).replace(/[ăâîșşțţĂÂÎȘŞȚŢ]/g, (ch) => DIACRITICS[ch] || ch);
}

function restore() {
  if (switchedCodepage && originalCodepage) {
    try {
      execSync("chcp " + originalCodepage, { stdio: "ignore" });
    } catch {}
  }
}

module.exports = { unicode, color, screen, chars, asciiSafe, restore };
