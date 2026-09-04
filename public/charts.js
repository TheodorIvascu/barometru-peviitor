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
 * Source by rule, as stacked bars.
 *
 * This was a heat map first, and a heat map was the wrong shape for it: with
 * forty sources against twenty-five rules most cells are empty, the few dark
 * ones sit at the top, and a shade is not a number - you could see that
 * something was wrong somewhere without ever reading how much.
 *
 * A stacked bar per source says the same thing with quantities. The length of
 * the bar is how many defects that scraper produces, each segment is one rule,
 * and the segment opens exactly its own jobs. The sources are ordered by damage,
 * so the top three bars are the three worth a morning's work.
 */
function sourceStacks(node, rows, labelOf, onSegment) {
  // the rules worth naming; everything rarer is honestly labelled "restul"
  const weight = new Map();
  for (const s of rows) {
    for (const id in (s.counts || {})) weight.set(id, (weight.get(id) || 0) + s.counts[id]);
  }
  const named = [...weight.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map((e) => e[0]);
  const namedSet = new Set(named);

  const data = rows.slice().reverse();          // ECharts draws the y axis upward
  const hosts = data.map((s) => s.host);
  node.style.height = Math.max(300, hosts.length * 30 + 90) + "px";

  const SERIES = named.concat(["__rest"]);

  return mount(node, (p) => {
    const shades = [p.red, p.orange, p.blue, p.green, p.grey];
    const colorAt = (i) => (i >= SERIES.length - 1 ? p.line : shades[i % shades.length]);
    const alphaAt = (i) => 1 - Math.floor(i / shades.length) * 0.32;

    return {
      grid: { left: 8, right: 24, top: 8, bottom: 46, containLabel: true },
      legend: {
        bottom: 0, textStyle: { color: p.subtle, fontSize: 10 }, itemWidth: 10, itemHeight: 10,
        icon: "rect", type: "scroll", pageTextStyle: { color: p.subtle },
      },
      xAxis: {
        type: "value",
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: p.line, opacity: 0.5 } },
        axisLabel: { color: p.subtle, fontSize: 10, fontFamily: p.mono },
      },
      yAxis: {
        type: "category", data: hosts,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: p.muted, fontSize: 11, fontFamily: p.mono },
      },
      tooltip: Object.assign(base(p).tooltip, {
        trigger: "item",
        formatter: (x) => x.seriesName + "<br>" + hosts[x.dataIndex] + "<br>"
          + Number(x.value).toLocaleString("ro-RO") + " joburi",
      }),
      series: SERIES.map((id, i) => ({
        name: id === "__rest" ? "restul regulilor" : labelOf(id),
        type: "bar",
        stack: "defecte",
        barMaxWidth: 20,
        ruleId: id,
        itemStyle: { color: colorAt(i), opacity: alphaAt(i) },
        emphasis: { itemStyle: { opacity: 1 } },
        data: data.map((s) => {
          const counts = s.counts || {};
          if (id !== "__rest") return counts[id] || 0;
          let rest = 0;
          for (const k in counts) if (!namedSet.has(k)) rest += counts[k];
          return rest;
        }),
      })),
    };
  }, (e) => {
    const id = SERIES[e.seriesIndex];
    if (!onSegment || id === "__rest" || !e.value) return;
    onSegment(id, hosts[e.dataIndex], labelOf(id));
  });
}

/** the biggest occupations, sized by how many jobs carry the code */
function occupationTreemap(node, occupations, onTile) {
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
      data: occupations.map((o) => ({ name: o.name, value: o.count, code: o.code })),
    }],
  }), (e) => onTile && e.data && e.data.code && onTile(e.data.code, e.data.name));
}

/**
 * Every row of a list, as bars, with a window onto them.
 *
 * There are 10.679 companies and 1.845 localities, and the long tail is not
 * filler: it is where the broken fiscal codes and the misspelled town names
 * live. So the chart holds all of them and shows twenty-five at a time; drag
 * the slider on the right to walk down the list. Each bar opens its own jobs.
 */
function topBars(node, rows, onBar) {
  const data = rows.slice().reverse();          // ECharts draws the y axis upward
  const window25 = Math.max(0, 100 - (25 / Math.max(1, data.length)) * 100);

  return mount(node, (p) => ({
    grid: { left: 8, right: 74, top: 4, bottom: 4, containLabel: true },
    xAxis: { type: "value", show: false },
    yAxis: {
      type: "category", data: data.map((r) => r.name),
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: p.muted, fontSize: 11, width: 220, overflow: "truncate" },
    },
    dataZoom: data.length > 25 ? [
      { type: "slider", yAxisIndex: 0, start: window25, end: 100, width: 12, right: 8,
        borderColor: p.line, backgroundColor: p.base,
        fillerColor: p.surface, handleStyle: { color: p.grey },
        dataBackground: { lineStyle: { color: p.line }, areaStyle: { color: p.surface } },
        selectedDataBackground: { lineStyle: { color: p.blue }, areaStyle: { color: p.blue, opacity: .25 } },
        textStyle: { color: p.subtle, fontSize: 9 } },
      { type: "inside", yAxisIndex: 0, start: window25, end: 100 },
    ] : undefined,
    tooltip: Object.assign(base(p).tooltip, {
      formatter: (x) => data[x.dataIndex].name + "<br>"
        + Number(x.value).toLocaleString("ro-RO") + " joburi",
    }),
    series: [{
      type: "bar", barMaxWidth: 18,
      itemStyle: { color: p.blue, borderRadius: [0, 2, 2, 0] },
      data: data.map((r) => ({ value: r.count, raw: r.raw })),
      label: {
        show: true, position: "right", color: p.subtle, fontFamily: p.mono, fontSize: 11,
        formatter: (x) => Number(x.value).toLocaleString("ro-RO"),
      },
    }],
  }), (e) => onBar && onBar(e.data.raw, data[e.dataIndex].name));
}


/**
 * Romania, by county.
 *
 * No tile server and no geocoder: the county outlines are a GeoJSON file we
 * serve ourselves, and SIRUTA already says which county every locality sits in,
 * so nothing here calls out to Nominatim or Photon. That also means the map
 * works offline, keeps working when someone else's rate limit runs out, and
 * cannot leak a single query about what this dashboard is looking at.
 *
 * The county names in the outline file are unaccented; SIRUTA's are not, so
 * both sides are folded before they are compared.
 */
let mapReady = null;

function loadRomania() {
  if (mapReady) return mapReady;
  mapReady = fetch("vendor/romania-judete.geojson")
    .then((r) => r.json())
    .then((geo) => { window.echarts.registerMap("romania", geo); return geo; });
  return mapReady;
}

const foldCounty = (v) => String(v || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[șş]/gi, "s").replace(/[țţ]/gi, "t").toLowerCase().trim();

async function countyMap(node, items, onCounty) {
  const geo = await loadRomania();
  // the outline decides the spelling; our counts are matched onto it
  const byFolded = new Map(items.map((it) => [foldCounty(it.value), it]));
  const data = geo.features.map((f) => {
    const name = f.properties.name;
    const hit = byFolded.get(foldCounty(name));
    return { name, value: hit ? hit.count : 0, county: hit ? hit.value : name };
  });
  const max = Math.max(1, ...data.map((d) => d.value));

  return mount(node, (p) => ({
    tooltip: Object.assign(base(p).tooltip, {
      formatter: (x) => x.data.county + "<br>"
        + (x.data.value ? Number(x.data.value).toLocaleString("ro-RO") + " joburi" : "niciun job localizat aici"),
    }),
    visualMap: {
      min: 0, max, calculable: false, left: 8, bottom: 8,
      itemWidth: 12, itemHeight: 120,
      text: [Number(max).toLocaleString("ro-RO"), "0"],
      textStyle: { color: p.subtle, fontSize: 10 },
      inRange: { color: [p.surface, p.blue, p.green] },
    },
    series: [{
      type: "map", map: "romania", roam: false,
      left: 0, right: 0, top: 8, bottom: 8,
      itemStyle: { borderColor: p.line, borderWidth: 0.8 },
      emphasis: { itemStyle: { borderColor: p.text, borderWidth: 1.5 }, label: { show: false } },
      select: { disabled: true },
      label: { show: false },
      data,
    }],
  }), (e) => onCounty && e.data && e.data.value && onCounty(e.data.county, e.data.value));
}

window.Charts = {
  mount, redrawAll, locationDonut, ruleBars, sourceStacks, occupationTreemap, topBars, countyMap,
};
