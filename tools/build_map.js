"use strict";
/**
 * tools/build_map.js — county outlines for the map, from the official dataset.
 *
 * Source: geo-spatial.org, "Județe, România (poligon)", processed from ANCPI
 * data, CC BY-SA 4.0.
 *   https://services.geo-spatial.org/data/administrative_boundaries/county/ro_admin_county_polygon.topojson
 *
 * The TopoJSON is 3 MB with 364.000 points; a browser map needs ~1% of that.
 * Arcs are simplified (Douglas-Peucker) BEFORE the polygons are assembled, so
 * two neighbouring counties still share exactly the same border and no gaps
 * or slivers appear between them.
 *
 *   node tools/build_map.js <path/to/ro_admin_county_polygon.topojson> [tolerance_deg]
 */
const fs = require("fs");
const path = require("path");

const src = process.argv[2];
const tol = Number(process.argv[3]) || 0.004;          // degrees; ~400 m
if (!src) { console.error("usage: node tools/build_map.js <topojson> [tolerance]"); process.exit(1); }

const topo = JSON.parse(fs.readFileSync(src, "utf8"));
const { scale, translate } = topo.transform;

// ---- decode arcs (delta-encoded, quantized) ---------------------------------
const arcs = topo.arcs.map((arc) => {
  let x = 0, y = 0;
  return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * scale[0] + translate[0], y * scale[1] + translate[1]]; });
});

// ---- simplify each arc, keeping its endpoints ----------------------------------
function dp(points, eps) {
  if (points.length <= 2) return points;
  const [ax, ay] = points[0], [bx, by] = points[points.length - 1];
  const len = Math.hypot(bx - ax, by - ay);
  let maxD = -1, idx = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const d = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [points[0], points[points.length - 1]];
  return dp(points.slice(0, idx + 1), eps).slice(0, -1).concat(dp(points.slice(idx), eps));
}
const simple = arcs.map((a) => dp(a, tol));

// ---- assemble rings -------------------------------------------------------------
const round = ([x, y]) => [+x.toFixed(4), +y.toFixed(4)];
function ring(indexes) {
  const out = [];
  for (const i of indexes) {
    const a = i < 0 ? simple[~i].slice().reverse() : simple[i];
    for (let k = out.length ? 1 : 0; k < a.length; k++) out.push(round(a[k]));
  }
  return out;
}
const obj = topo.objects[Object.keys(topo.objects)[0]];
const features = obj.geometries.map((g) => ({
  type: "Feature",
  properties: { name: g.properties.name, code: g.properties.mnemonic },
  geometry: g.type === "Polygon"
    ? { type: "Polygon", coordinates: g.arcs.map(ring) }
    : { type: "MultiPolygon", coordinates: g.arcs.map((poly) => poly.map(ring)) },
}));
const out = { type: "FeatureCollection",
  attribution: "geo-spatial.org / ANCPI, CC BY-SA 4.0, simplified for display",
  features };

const dst = path.join(__dirname, "..", "public", "vendor", "romania-judete.geojson");
fs.writeFileSync(dst, JSON.stringify(out));
const pts = features.reduce((n, f) => n + f.geometry.coordinates.flat(f.geometry.type === "Polygon" ? 1 : 2).length, 0);
console.log(`${path.relative(process.cwd(), dst)}  ${features.length} județe, ${pts} puncte, ${Math.round(fs.statSync(dst).size / 1024)} KB, toleranță ${tol}°`);
