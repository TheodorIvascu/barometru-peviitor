"use strict";
const readline = require("readline");

/** yes/no question on the terminal. Returns true only for an explicit yes. */
let _rl = null;
function rl() {
  if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return _rl;
}
function closeAsk() { if (_rl) { _rl.close(); _rl = null; } }

// Non-interactive (piped) input: slurp every answer up front, because the
// stream can close before later prompts are asked.
let _queue = null;
function queued() {
  if (_queue) return _queue;
  _queue = new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { buf += d; });
    process.stdin.on("end", () => resolve(buf.split(String.fromCharCode(10)).map((x) => x.trim())));
    process.stdin.resume();
  });
  return _queue;
}
let _answers = null;

async function nextPiped() {
  if (!_answers) _answers = await queued();
  return (_answers.shift() || "").trim();
}

/** yes/no question. Returns true only for an explicit yes. */
async function confirm(question) {
  if (process.stdin.isTTY !== true) {
    const a = await nextPiped();
    console.log("  " + question + " [y/N] " + a);
    return a.toLowerCase() === "y" || a.toLowerCase() === "yes";
  }
  return new Promise((resolve) => {
    rl().question("  " + question + " [y/N] ", (a) => {
      const v = String(a).trim().toLowerCase();
      resolve(v === "y" || v === "yes");
    });
  });
}

/** free-text question with a default */
async function askText(question, def) {
  if (process.stdin.isTTY !== true) {
    const a = await nextPiped();
    console.log("  " + question + " " + (a || def || ""));
    return a || def;
  }
  return new Promise((resolve) => {
    rl().question("  " + question + (def ? " [" + def + "] " : " "), (a) => resolve(String(a).trim() || def));
  });
}

const c = {
  dim: (s) => "\u001b[2m" + s + "\u001b[0m",
  bold: (s) => "\u001b[1m" + s + "\u001b[0m",
  green: (s) => "\u001b[32m" + s + "\u001b[0m",
  yellow: (s) => "\u001b[33m" + s + "\u001b[0m",
  red: (s) => "\u001b[31m" + s + "\u001b[0m",
  cyan: (s) => "\u001b[36m" + s + "\u001b[0m",
};

function banner(title, sub) {
  console.log("");
  console.log(title + (sub ? "  -  " + sub : ""));
}

function step(n, of, title) {
  console.log("");
  console.log("[" + n + "/" + of + "] " + title);
}

module.exports = { confirm, askText, closeAsk, c, banner, step };
