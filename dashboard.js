#!/usr/bin/env node
"use strict";
/**
 * DOCTOR SOLR — live terminal dashboard for the peviitor job Solr index.
 * Entry point. Run with: node dashboard.js
 *
 * Owns: this file + tui/*.js. Never writes to Solr (read-only via lib/solr.js).
 *
 * One data bundle (tui/data.js's loadAll()), three screens (1/2/3):
 *   1 Validation - per-field filled%/valid%/problems table (the centerpiece)
 *   2 Stats       - headline numbers
 *   3 Warnings    - concrete offenders with real examples
 */
const caps = require("./tui/caps.js");
const { c } = require("./tui/theme.js");
const { termWidth } = require("./tui/layout.js");
const { renderBanner } = require("./tui/banner.js");
const { renderMenu, renderFooter, TABS } = require("./tui/menu.js");
const { renderPanel } = require("./tui/panels.js");
const { setupKeyboard } = require("./tui/keyboard.js");
const data = require("./tui/data.js");
const { Solr } = require("./lib/solr.js");

const REFRESH_MS = 30000;

const state = {
  tab: 1,
  bundle: null,
  loading: false,
  live: null,
  checking: true,
  solrUrl: new Solr().url,
  lastUpdated: null,
  showHelp: false,
  normalizing: false,
  confirmNormalize: false,
  normalizeMsg: null,
  quitting: false,
};

// ---------------- screen control ----------------
// Repaint-in-place (alt-screen/cursor/clear) is a VT capability, independent
// of color: NO_COLOR must not turn off screen repaint, and a non-TTY /
// redirected stream must never receive cursor escapes (they'd show up as
// literal garbage, or worse, silently turn every render into an appended
// full-page dump instead of an in-place repaint).
let screenReady = false;
function enterScreen() {
  if (caps.screen) process.stdout.write("\x1b[?1049h\x1b[?25l");
  screenReady = true;
}
function leaveScreen() {
  if (!screenReady) return;
  if (caps.screen) process.stdout.write("\x1b[?25h\x1b[?1049l");
  screenReady = false;
}
function clearFrame() {
  if (caps.screen) return "\x1b[H\x1b[2J\x1b[3J";
  return "\n"; // no repaint capability: just separate frames, never spam full blank pages
}

// ---------------- render ----------------
function helpLines(width) {
  const rows = [
    "DOCTOR SOLR — live dashboard for the peviitor job index",
    "",
    "Screens:  " + TABS.map((t) => t.n + ") " + t.label).join("   "),
    "",
    "Keys:",
    "  1-3        jump to a screen",
    "  " + (caps.unicode ? "←/→ or ↑/↓" : "left/right or up/down") + "  switch screens",
    "  r          refresh now",
    "  q / Ctrl+C quit",
    "  ?          toggle this help",
  ];
  return require("./tui/layout.js").box("HELP", rows, width, c.gray);
}

function render() {
  const width = termWidth();
  const lines = [];
  lines.push(...renderBanner({ solrUrl: state.solrUrl, live: state.live, checking: state.checking }));
  lines.push(renderMenu(state.tab));
  lines.push("");
  if (state.showHelp) {
    lines.push(...helpLines(width));
  } else {
    lines.push(...renderPanel(state.tab, state.bundle, width));
  }
  lines.push("");
  lines.push(renderFooter({ loading: state.loading, lastUpdated: state.lastUpdated, confirmNormalize: state.confirmNormalize, normalizing: state.normalizing, normalizeMsg: state.normalizeMsg }));

  process.stdout.write(clearFrame() + lines.join("\n") + "\n");
}

// ---------------- data loading ----------------
async function loadBundle() {
  state.loading = true;
  try {
    state.bundle = await data.loadAll();
  } catch (e) {
    state.bundle = { validation: { data: null, source: "error", error: (e && e.message) || String(e) } };
  } finally {
    state.loading = false;
    state.lastUpdated = new Date().toLocaleTimeString();
    if (!state.quitting) render();
    maybeAutoExit();
  }
}

function checkLive() {
  state.checking = true;
  data.ping().then((ok) => {
    state.live = ok;
    state.checking = false;
    if (!state.quitting) render();
  });
}

function refreshAll() {
  checkLive();
  render(); // paint immediately with whatever we have (or "loading...")
  loadBundle();
}

// ---------------- lifecycle ----------------
function quit() {
  if (state.quitting) return;
  state.quitting = true;
  clearInterval(refreshTimer);
  teardownKeyboard && teardownKeyboard();
  leaveScreen();
  caps.restore();
  process.exit(0);
}

let teardownKeyboard = null;
let refreshTimer = null;


// ---------------- normalize action (opt-in, never automatic) ----------------
// Writes to Solr, so it is gated behind an explicit confirmation. The dashboard
// itself stays read-only; the work is delegated to `doctor.js normalize --apply`.
function runNormalize() {
  if (state.normalizing) return;
  if (!state.confirmNormalize) {
    state.confirmNormalize = true;
    render();
    return;
  }
  state.confirmNormalize = false;
  state.normalizing = true;
  render();

  const { spawn } = require("child_process");
  const child = spawn(process.execPath, ["doctor.js", "normalize", "--apply"], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  const grab = (b) => {
    tail = (tail + b.toString()).split(String.fromCharCode(10)).slice(-4).join(" | ").slice(-160);
    state.normalizeMsg = tail;
    render();
  };
  child.stdout.on("data", grab);
  child.stderr.on("data", grab);
  child.on("close", (code) => {
    state.normalizing = false;
    state.normalizeMsg = code === 0 ? "normalize finished - refreshing" : "normalize failed (exit " + code + ")";
    render();
    refreshAll();
    setTimeout(() => { state.normalizeMsg = null; render(); }, 4000);
  });
}

function main() {
  enterScreen();
  refreshAll();

  // The 30s auto-refresh exists purely to keep a live, in-place-repainted
  // screen current. Without repaint capability (non-TTY / redirected
  // output) it would just append more full frames to an already-static
  // stream, so skip it entirely there — piped keys (tab switches, refresh,
  // quit) still work either way.
  if (caps.screen) {
    refreshTimer = setInterval(refreshAll, REFRESH_MS);
    refreshTimer.unref && refreshTimer.unref();
  }

  teardownKeyboard = setupKeyboard({
    onTab: (n) => {
      state.confirmNormalize = false;
      state.tab = n;
      state.showHelp = false;
      render();
    },
    onPrev: () => {
      state.tab = state.tab === 1 ? 3 : state.tab - 1;
      state.showHelp = false;
      render();
    },
    onNext: () => {
      state.tab = state.tab === 3 ? 1 : state.tab + 1;
      state.showHelp = false;
      render();
    },
    onRefresh: () => refreshAll(),
    onNormalize: () => runNormalize(),
    onHelp: () => {
      state.showHelp = !state.showHelp;
      render();
    },
    onQuit: quit,
  });

  process.stdout.on("resize", () => render());
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);

  // Non-TTY input (piped/redirected/closed stdin) has no interactive
  // terminal to keep waiting on: once the pipe is exhausted and every
  // in-flight fetch has settled, exit cleanly instead of idling forever on
  // a lingering keep-alive socket. A real TTY never fires 'end' here.
  process.stdin.on("end", () => {
    stdinEnded = true;
    maybeAutoExit();
  });
}

let stdinEnded = false;
function maybeAutoExit() {
  if (!process.stdin.isTTY && stdinEnded && !state.loading && !state.quitting) {
    quit();
  }
}

process.on("uncaughtException", (e) => {
  try {
    leaveScreen();
    caps.restore();
  } catch {}
  console.error("DOCTOR SOLR crashed:", e && e.stack ? e.stack : e);
  process.exit(1);
});

main();
