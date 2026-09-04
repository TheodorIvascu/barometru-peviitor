"use strict";
/**
 * BAROMETRU — charts.
 *
 * ECharts, served from our own host. It was picked over the alternatives for
 * one reason: it draws on a canvas and hands back the data item that was
 * clicked, so every mark on screen can open the jobs behind it. A number nobody
 * can drill into is a number nobody can act on.
 *
 * Every chart reads its colours from the same CSS variables as the rest of the
 * app, so none of them can drift away from the theme, and all of them are
 * rebuilt when the theme changes rather than repainted by hand.
 */

const charts = new Map();          // node -> { inst, draw }

function tok(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function palette() {
  return {
    text: tok("--text-main"),
    muted: tok("--text-muted"),
    subtle: tok("--text-subtle"),
    line: tok("--border-subtle"),
    surface: tok("--bg-surface"),
    base: tok("--bg-base"),
    green: tok("--color-green"),
    orange: tok("--color-orange"),
    red: tok("--color-red"),
    blue: tok("--color-blue"),
    grey: tok("--color-grey"),
    mono: tok("--font-mono"),
    sans: tok("--font-sans"),
  };
}

/** the shell every chart shares: no chart junk, our type, our colours */
function base(p) {
  return {
    animationDuration: 260,
    textStyle: { fontFamily: p.sans, color: p.muted },
    tooltip: {
      backgroundColor: p.surface,
      borderColor: p.line,
      borderWidth: 1,
      textStyle: { color: p.text, fontSize: 12 },
      extraCssText: "box-shadow:none; border-radius:4px;",
    },
    grid: { left: 8, right: 16, top: 8, bottom: 8, containLabel: true },
  };
}

/**
 * Mount a chart and keep it alive.
 *
 * `build(p)` returns the option object; it is called again on every theme
 * change, which is why it takes the palette rather than closing over it.
 */
function mount(node, build, onClick) {
  if (!window.echarts || !node) return null;
  const prev = charts.get(node);
  if (prev) { prev.inst.dispose(); charts.delete(node); }

  const inst = window.echarts.init(node, null, { renderer: "canvas" });
  const draw = () => inst.setOption(Object.assign(base(palette()), build(palette())), true);
  draw();
  if (onClick) inst.on("click", onClick);
  charts.set(node, { inst, draw });
  return inst;
}

function redrawAll() {
  for (const c of charts.values()) { c.draw(); c.inst.resize(); }
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { for (const c of charts.values()) c.inst.resize(); }, 120);
});

// ---------------------------------------------------------------------------
// the charts themselves
// ---------------------------------------------------------------------------

/** how the jobs split across location kinds; each arc opens its rule */
function locationDonut(node, items, meta, onSlice) {
  const colorOf = (p, key) => ({
    fixed: p.green, country: p.blue, international: p.orange, junk: p.red,
  })[key] || p.grey;

  return mount(node, (p) => ({
    tooltip: Object.assign(base(p).tooltip, {
      formatter: (x) => x.name + "<br>" + x.value.toLocaleString("ro-RO") + " joburi, " + x.percent + "%",
    }),
    series: [{
      type: "pie",
      radius: ["58%", "86%"],
      center: ["50%", "50%"],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: p.surface, borderWidth: 2 },
      label: { show: false },
      emphasis: { scale: false, itemStyle: { opacity: 0.85 } },
      data: items.map((it) => ({
        name: (meta[it.value] || {}).label || it.value,
        value: it.count,
        key: it.value,
        itemStyle: { color: colorOf(p, it.value) },
      })),
    }],
  }), (e) => onSlice && onSlice(e.data.key, e.data.name));
}

/** the rules that fire hardest, as bars that open their own jobs */
function ruleBars(node, rules, onBar) {
  const data = rules.slice().reverse();
  const colorOf = (p, sev) => ({
    blocant: p.red, avertisment: p.orange, info: p.blue, cosmetic: p.grey,
  })[sev] || p.grey;

  return mount(node, (p) => ({
    grid: { left: 8, right: 62, top: 4, bottom: 4, containLabel: true },
    xAxis: { type: "value", show: false },
    yAxis: {
      type: "category",
      data: data.map((r) => r.label),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: p.muted, fontSize: 11, width: 190, overflow: "truncate" },
    },
    tooltip: Object.assign(base(p).tooltip, {
      formatter: (x) => {
        const r = data[x.dataIndex];
        return r.label + "<br>" + r.count.toLocaleString("ro-RO") + " joburi, " + r.pct + "% din total";
      },
    }),
    series: [{
      type: "bar",
      barWidth: "62%",
      itemStyle: { borderRadius: [0, 2, 2, 0] },
      data: data.map((r) => ({ value: r.count, id: r.id, itemStyle: { color: colorOf(p, r.severity) } })),
      label: {
        show: true, position: "right", color: p.subtle, fontFamily: p.mono, fontSize: 11,
        formatter: (x) => Number(x.value).toLocaleString("ro-RO"),
      },
    }],
  }), (e) => onBar && onBar(e.data.id, data[e.dataIndex].label));
}

/**
 * Source by rule.
 *
 * Shade is the share of THAT source's jobs the rule hits, not the raw count, so
 * a small feed that is entirely broken reads as loudly as a large one. A dark
 * column means every scraper makes the same mistake and the fault is probably
 * ours; a dark row means one feed is broken and fixing it cleans thousands of
 * rows at once. Every cell opens exactly its own jobs.
 */
function sourceHeatmap(node, rows, labelOf, onCell) {
  const weight = new Map();
  for (const s of rows) {
    for (const id in (s.cells || {})) weight.set(id, (weight.get(id) || 0) + s.cells[id]);
  }
  const cols = [...weight.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  const hosts = rows.map((s) => s.host);

  const data = [];
  rows.forEach((s, y) => cols.forEach((id, x) => {
    const v = (s.cells || {})[id] || 0;
    if (v > 0) data.push([x, y, v, id]);
  }));

  node.style.height = Math.max(260, hosts.length * 22 + 170) + "px";

  return mount(node, (p) => ({
    grid: { left: 8, right: 24, top: 8, bottom: 128, containLabel: true },
    xAxis: {
      type: "category", data: cols.map(labelOf), splitArea: { show: false },
      axisLine: { lineStyle: { color: p.line } }, axisTick: { show: false },
      axisLabel: { color: p.muted, fontSize: 10, rotate: 40, width: 118, overflow: "truncate" },
    },
    yAxis: {
      type: "category", data: hosts, splitArea: { show: false },
      axisLine: { lineStyle: { color: p.line } }, axisTick: { show: false },
      axisLabel: { color: p.muted, fontSize: 10, fontFamily: p.mono },
    },
    visualMap: {
      min: 0, max: 100, calculable: false,
      orient: "horizontal", left: "center", bottom: 6, itemWidth: 12, itemHeight: 110,
      text: ["100% din sursă", "0%"],
      textStyle: { color: p.subtle, fontSize: 10 },
      inRange: { color: [p.base, p.orange, p.red] },
    },
    tooltip: Object.assign(base(p).tooltip, {
      formatter: (x) => labelOf(x.data[3]) + "<br>" + hosts[x.data[1]]
        + "<br>" + x.data[2] + "% din joburile sursei",
    }),
    series: [{
      type: "heatmap",
      data,
      itemStyle: { borderColor: p.line, borderWidth: 0.5 },
      emphasis: { itemStyle: { borderColor: p.text, borderWidth: 1.5 } },
      progressive: 0,
    }],
  }), (e) => onCell && onCell(e.data[3], hosts[e.data[1]], labelOf(e.data[3])));
}

/** the biggest occupations, sized by how many jobs carry the code */
function occupationTreemap(node, occupations) {
  return mount(node, (p) => ({
    tooltip: Object.assign(base(p).tooltip, {
      formatter: (x) => x.name + "<br>" + Number(x.value).toLocaleString("ro-RO") + " joburi",
    }),
    series: [{
      type: "treemap",
      roam: false, nodeClick: false, breadcrumb: { show: false },
      top: 0, left: 0, right: 0, bottom: 0,
      label: { fontSize: 11, color: "#fff", overflow: "truncate" },
      levels: [{
        color: [p.blue, p.green, p.orange, p.grey],
        colorMappingBy: "index",
        itemStyle: { borderWidth: 2, gapWidth: 2, borderColor: p.surface },
      }],
      data: occupations.map((o) => ({ name: o.name, value: o.count })),
    }],
  }));
}

/** a plain horizontal bar for a top-N list, over the same rows as its table */
function topBars(node, rows, onBar) {
  const data = rows.slice(0, 12).slice().reverse();
  return mount(node, (p) => ({
    grid: { left: 8, right: 66, top: 4, bottom: 4, containLabel: true },
    xAxis: { type: "value", show: false },
    yAxis: {
      type: "category", data: data.map((r) => r.name),
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: p.muted, fontSize: 11, width: 210, overflow: "truncate" },
    },
    tooltip: Object.assign(base(p).tooltip, {
      formatter: (x) => data[x.dataIndex].name + "<br>"
        + Number(x.value).toLocaleString("ro-RO") + " joburi",
    }),
    series: [{
      type: "bar", barWidth: "60%",
      itemStyle: { color: p.blue, borderRadius: [0, 2, 2, 0] },
      data: data.map((r) => ({ value: r.count, raw: r.raw })),
      label: {
        show: true, position: "right", color: p.subtle, fontFamily: p.mono, fontSize: 11,
        formatter: (x) => Number(x.value).toLocaleString("ro-RO"),
      },
    }],
  }), (e) => onBar && onBar(e.data.raw, data[e.dataIndex].name));
}

window.Charts = {
  mount, redrawAll, locationDonut, ruleBars, sourceHeatmap, occupationTreemap, topBars,
};
