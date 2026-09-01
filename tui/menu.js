"use strict";
const { c } = require("./theme.js");
const { termWidth, visLen } = require("./layout.js");
const caps = require("./caps.js");

const TABS = [
  { n: 1, label: "Validation" },
  { n: 2, label: "Stats" },
  { n: 3, label: "Warnings" },
];

function renderMenu(active) {
  const parts = TABS.map((t) => {
    const txt = ` ${t.n} ${t.label} `;
    return t.n === active ? c.bold(c.bgBlue(c.brightWhite(txt))) : c.dim(txt);
  });
  return parts.join(" ");
}

function renderFooter(state) {
  const width = termWidth();
  const arrows = caps.unicode ? "←/→" : "<-/->";
  const hints = `q quit   r refresh   n normalize   ? help   ${arrows} switch`;
  let status;
  if (state.confirmNormalize) status = c.yellow("press n again to run normalize (writes to Solr), any other key cancels");
  else if (state.normalizing) status = c.yellow("normalizing... " + (state.normalizeMsg || ""));
  else if (state.normalizeMsg) status = c.green(state.normalizeMsg);
  else if (state.loading) status = c.yellow("loading...");
  else status = c.dim(state.lastUpdated ? "last updated " + state.lastUpdated : "never updated");
  const left = c.dim(hints);
  const right = status;
  const gap = Math.max(1, width - visLen(left) - visLen(right));
  return left + " ".repeat(gap) + right;
}

module.exports = { renderMenu, renderFooter, TABS };
