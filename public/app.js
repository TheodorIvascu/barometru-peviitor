"use strict";
/**
 * BAROMETRU — frontend.
 *
 * Every number on screen comes from the API over the live production index.
 * Nothing here is hardcoded, sampled or filled in: if a call fails, the panel
 * says so. Key names are read exactly as server/jobs.js and server/pipeline.js
 * emit them — never guessed, because a wrong guess silently renders zeros over
 * healthy data.
 */

const $ = (s, r) => (r || document).querySelector(s);
const el = (t, cls, txt) => { const n = document.createElement(t); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const nf = (n) => (n == null ? "—" : Number(n).toLocaleString("ro-RO"));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** the scraper leaves HTML entities in names; show them readable */
const deent = (s) => String(s == null ? "" : s)
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");

async function api(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 120000);
  try {
    const res = await fetch(url, Object.assign({ headers: { Accept: "application/json" }, signal: ctrl.signal }, opts || {}));
    clearTimeout(t);
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: (data && data.error) || ("HTTP " + res.status), data };
    return { ok: true, data };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: e.name === "AbortError" ? "a durat prea mult" : "serverul nu răspunde" };
  }
}
const post = (u, b, t) => api(u, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(b || {}) }, t);

function clickable(node, label, fn) {
  node.setAttribute("role", "button");
  node.setAttribute("tabindex", "0");
  if (label) node.setAttribute("aria-label", label);
  node.classList.add("clickable");
  node.addEventListener("click", fn);
  node.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } });
}

function errorBox(title, detail) {
  const d = el("div", "error-box");
  d.appendChild(el("b", null, title));
  d.appendChild(document.createTextNode(detail || ""));
  return d;
}

const state = { checks: null, loaded: {}, stale: false };

// =====================================================================
// drawer — the one place job rows are shown
// =====================================================================
const drawer = {
  query: null, title: "", offset: 0, limit: 50, total: 0, rows: [], returnTo: null, term: "",

  async open(query, title) {
    this.query = query; this.title = title; this.offset = 0; this.term = "";
    $("#drawer-q").value = "";
    this.returnTo = document.activeElement;
    const d = $("#job-drawer");
    d.classList.add("open");
    d.setAttribute("aria-hidden", "false");
    $("#drawer-overlay").classList.add("open");
    await this.load();
    $("#btn-close-drawer").focus();
  },

  close() {
    const d = $("#job-drawer");
    d.classList.remove("open");
    d.setAttribute("aria-hidden", "true");
    $("#drawer-overlay").classList.remove("open");
    if (this.returnTo && this.returnTo.focus) this.returnTo.focus();
  },

  isOpen() { return $("#job-drawer").classList.contains("open"); },

  async load() {
    $("#drawer-title").textContent = this.title;
    $("#drawer-subtitle").textContent = "se încarcă…";
    $("#drawer-body").innerHTML = '<div class="loading">Aducem joburile…</div>';

    const qs = this.query + "&offset=" + this.offset + "&limit=" + this.limit
      + (this.term ? "&q=" + encodeURIComponent(this.term) : "");
    const r = await api("/api/jobs?" + qs);
    if (!r.ok) {
      $("#drawer-body").innerHTML = "";
      $("#drawer-body").appendChild(errorBox("Nu pot afișa joburile", (r.data && r.data.hint) || r.error));
      $("#drawer-subtitle").textContent = "";
      return;
    }
    this.total = r.data.total;
    this.rows = r.data.rows || [];
    $("#drawer-subtitle").textContent = nf(this.total) + " joburi"
      + (this.term ? " care conțin „" + this.term + "”" : "") + " · date reale din producție";
    this.render();

    const from = this.total ? this.offset + 1 : 0;
    $("#drawer-page").textContent = from + "–" + Math.min(this.offset + this.limit, this.total) + " din " + nf(this.total);
    $("#btn-prev").disabled = this.offset <= 0;
    $("#btn-next").disabled = this.offset + this.limit >= this.total;
  },

  render() {
    const body = $("#drawer-body");
    if (!this.rows.length) {
      body.innerHTML = '<div class="empty-box">Niciun job aici.</div>';
      return;
    }
    let h = "<table><thead><tr><th>Titlu</th><th>Companie</th><th>Locație</th><th>De ce e semnalat</th></tr></thead><tbody>";
    for (const r of this.rows) {
      h += "<tr>"
        + "<td><a href='" + esc(r.url) + "' target='_blank' rel='noopener'>" + esc(r.title || "(fără titlu)") + "</a>"
        + (r.date ? "<div class='cell-sub'>" + esc(String(r.date).slice(0, 10)) + "</div>" : "")
        + "</td>"
        + "<td>" + esc(deent(r.company)) + (r.cif ? "<div class='cell-sub'>CIF " + esc(r.cif) + "</div>" : "") + "</td>"
        + "<td>" + esc((r.location || []).join(", ") || "—") + "</td>"
        + "<td class='cell-why'>" + esc(whyText(r))
        + "<div class='row-actions'>"
        + "<button class='mini-btn' data-pv-q='" + esc(r.title || "") + "'>jobul pe peviitor</button>"
        + "<button class='mini-btn bx-find' data-title='" + esc(r.title || "") + "' data-company='" + esc(deent(r.company) || "") + "' data-cif='" + esc(r.cif || "") + "'>&#128269; găsește-l pe site</button>"
        + (r.cif
            ? "<button class='mini-btn' data-pv-cif='" + esc(r.cif) + "'>compania pe peviitor</button>"
            : "<button class='mini-btn' data-pv-q='" + esc(deent(r.company) || "") + "'>compania pe peviitor</button>")
        + "</div></td>"
        + "</tr>";
    }
    body.innerHTML = h + "</tbody></table>";

    // opens a real browser on the server machine, finds the row in their list,
    // highlights it and scrolls to it
    for (const b of body.querySelectorAll(".bx-find")) {
      b.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const old = b.textContent;
        b.disabled = true; b.textContent = "caut pe site…";
        const r = await post("/api/peviitor/open", {
          title: b.getAttribute("data-title"),
          company: b.getAttribute("data-company"),
          cif: b.getAttribute("data-cif") || undefined,
        }, 240000);
        b.disabled = false;
        if (!r.ok || !r.data || r.data.ok === false) { b.textContent = "n-a mers"; b.title = (r.data && r.data.error) || r.error; }
        else if (r.data.found) {
          // exact = the card carried the company too, not just the title
          b.textContent = (r.data.exact ? "găsit" : "titlu potrivit") + " (pag. " + r.data.page + ")";
          b.title = r.data.detail || "";
        }
        else { b.textContent = "nu apare în listă"; b.title = "căutat: " + (r.data.query || ""); }
        setTimeout(() => { b.textContent = old; b.title = ""; }, 6000);
      });
    }

    for (const b of body.querySelectorAll("[data-pv-q],[data-pv-cif]")) {
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const cif = b.getAttribute("data-pv-cif");
        if (cif) { window.open(pvCompany(cif), "_blank", "noopener"); return; }
        const t = (b.getAttribute("data-pv-q") || "").trim();
        if (t) window.open(pvSearch(t), "_blank", "noopener");
      });
    }
  },

  csv() {
    if (!this.rows.length) return;
    const head = ["titlu", "companie", "cif", "locatie", "workmode", "data", "url"];
    const lines = [head.join(",")].concat(this.rows.map((r) => [
      r.title, deent(r.company), r.cif, (r.location || []).join(" | "), r.workmode, r.date, r.url,
    ].map((v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"').join(",")));
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "barometru-" + this.query.replace(/[^a-z0-9]+/gi, "-") + ".csv";
    a.click();
  },
};

/**
 * peviitor.ro is a hash-routed single page app. `?q=` on the root is ignored -
 * the working addresses were found by driving their own search box in a real
 * browser (tools/probe_peviitor.js):
 *
 *   #/rezultate?q=<termen>&page=1   the search results
 *   #/company/<CIF>                 one company, exactly
 *
 * Prefer the CIF route for a company: searching "DELOITTE TAX SRL" as text
 * returns 41.038 results because the query matches on separate words.
 */
const pvSearch = (t) => "https://peviitor.ro/#/rezultate?q=" + encodeURIComponent(String(t).trim()) + "&page=1";
const pvCompany = (cif) => "https://peviitor.ro/#/company/" + encodeURIComponent(String(cif).trim());

/** a short, row-specific reason, from fields the API already returns */
function whyText(r) {
  const raw = (r.location || []).join(", ");
  const u = String(r.url || "");
  if (!u) return "fără url";
  if (!/^https?:\/\//i.test(u)) return u.startsWith("mailto:") ? "adresă de email, nu anunț" : "cale relativă, fără domeniu";
  if (/\s/.test(u)) return "spațiu în url — linkul se rupe";
  if (r.locKind === "junk") return "«" + raw + "» nu e o localitate";
  if (r.locKind === "country") return "«" + raw + "» — doar nivel de țară";
  if (r.locKind === "international") return "«" + raw + "» — în afara României";
  if (/&(amp|quot|lt|gt|#\d+);/i.test(String(r.company || ""))) return "HTML nedecodat în numele companiei";
  if (/<[^>]+>|&(amp|quot|lt|gt|#\d+);/i.test(String(r.title || ""))) return "HTML în titlu";
  if (!r.workmode) return "fără mod de lucru";
  return "";
}

// =====================================================================
// views
// =====================================================================
const VIEWS = [
  { id: "triaj", label: "Triaj" },
  { id: "locatii", label: "Locații" },
  { id: "companii", label: "Companii" },
  { id: "surse", label: "Surse" },
  { id: "ocupatii", label: "Ocupații (COR)" },
];

function renderNav() {
  const list = $("#nav-list");
  list.innerHTML = "";
  for (const v of VIEWS) {
    const li = el("li", "nav-item" + (v.id === "triaj" ? " active" : ""));
    li.dataset.target = v.id;
    li.setAttribute("role", "tab");
    li.appendChild(document.createTextNode(v.label));
    clickable(li, v.label, () => go(v.id));
    list.appendChild(li);
  }
}

function go(id) {
  for (const n of document.querySelectorAll(".nav-item")) n.classList.toggle("active", n.dataset.target === id);
  for (const s of document.querySelectorAll(".view-section")) {
    s.classList.remove("active");
    void s.offsetWidth;                       // restart the stagger animation
  }
  $("#view-" + id).classList.add("active");

  if (id === "locatii" && !state.loaded.locatii) { state.loaded.locatii = 1; loadBars("/api/top?field=location&limit=15", "locatii-container", "loc", "Joburi în "); }
  if (id === "companii" && !state.loaded.companii) { state.loaded.companii = 1; loadBars("/api/top?field=company&limit=15", "companii-container", "company", "Joburi la "); }
  if (id === "surse" && !state.loaded.surse) { state.loaded.surse = 1; loadSources(); }
  if (id === "ocupatii" && !state.loaded.ocupatii) { state.loaded.ocupatii = 1; loadOccupations(); }
}

// ---------------------------------------------------------------- triaj
async function loadTriaj() {
  const r = await api("/api/checks");
  if (!r.ok) {
    $("#rules-groups-container").innerHTML = "";
    $("#rules-groups-container").appendChild(errorBox("Nu pot citi verificările", r.error + " — /api/checks"));
    return;
  }
  const d = r.data;
  state.checks = d;
  renderNav();

  $("#stat-total").textContent = nf(d.total);
  $("#stat-total-sub").textContent = d.scannedAt ? new Date(d.scannedAt).toLocaleString("ro-RO") : "";
  $("#stat-measured").textContent = d.measured + " / " + d.totalRules;
  const clean = d.rules.filter((x) => x.measured && x.count === 0).length;
  $("#stat-rules-sub").textContent = clean + " trec fără nicio problemă";
  // when the counts come from the snapshot the rows behind them are not loaded
  // yet, so say so rather than letting someone click into an empty drawer
  state.stale = !!d.stale;
  const when = d.scannedAt ? new Date(d.scannedAt).toLocaleString("ro-RO") : "";
  $("#freshness").textContent = !when ? "analiza nu a rulat inca"
    : d.stale ? "date din " + when + ", se recalculează" : "analizat " + when;

  // the thermometer reads FEVER: 100 - health, so a hot bulb means bad data
  const fever = d.score == null ? null : Math.max(0, Math.min(100, 100 - d.score));
  const band = fever == null ? "warn" : fever > 45 ? "crit" : fever > 20 ? "warn" : "good";
  const words = { good: "date sănătoase", warn: "câteva probleme", crit: "probleme serioase" };

  $("#thermo-container").className = "thermo-gauge gauge-" + band;
  const scoreEl = $("#metric-score");
  scoreEl.textContent = fever == null ? "--" : String(fever);
  scoreEl.className = "anomaly-score score-" + band;
  const st = $("#metric-status");
  st.textContent = words[band];
  st.style.color = band === "good" ? "var(--color-green)" : band === "warn" ? "var(--color-orange)" : "var(--color-red)";
  clickable(scoreEl, "vezi problemele", () => go("triaj"));
  setTimeout(() => { $("#thermo-liquid").style.height = (fever || 0) + "%"; }, 120);

  // what pushes the temperature up, by weight × share
  const pills = $("#top-issues-pills");
  pills.innerHTML = "";
  const top = d.rules
    .filter((x) => x.measured && x.count > 0 && x.pct != null)
    .map((x) => ({ r: x, v: (x.weight || 0) * x.pct }))
    .sort((a, b) => b.v - a.v).slice(0, 3);
  if (!top.length) pills.appendChild(el("div", "empty-box", "Nicio regulă cu rezultate."));
  for (const t of top) {
    const p = el("div", "pill sev-" + t.r.severity);
    p.appendChild(el("span", null, t.r.label));
    p.appendChild(el("span", null, nf(t.r.count)));
    p.querySelector("span:last-child").style.fontFamily = "var(--font-mono)";
    clickable(p, t.r.label, () => drawer.open("issue=" + encodeURIComponent(t.r.id), t.r.label));
    pills.appendChild(p);
  }

  clickable($("#card-total"), "toate joburile", () => drawer.open("issue=" + encodeURIComponent(d.rules[0].id), d.rules[0].label));

  renderDonut();
  renderRules(d);
}

async function renderDonut() {
  const r = await api("/api/top?field=loc_kind&limit=10");
  const legend = $("#donut-legend");
  const donut = $("#css-donut-chart");
  legend.innerHTML = "";
  if (!r.ok || !r.data || !Array.isArray(r.data.items)) {
    legend.appendChild(errorBox("Distribuția locațiilor", (r.data && r.data.error) || r.error));
    return;
  }
  const META = {
    fixed:         { label: "localitate identificată", rule: null,                color: "var(--color-green)" },
    country:       { label: "doar nivel de țară",      rule: "loc_country",       color: "var(--color-blue)" },
    international: { label: "în afara României",       rule: "loc_international", color: "var(--color-orange)" },
    junk:          { label: "nu e un loc",             rule: "loc_junk",          color: "var(--color-red)" },
  };
  const items = r.data.items.filter((x) => x.count > 0);
  if (!items.length) { legend.appendChild(el("div", "empty-box", "Nemăsurat.")); return; }

  const total = items.reduce((a, b) => a + b.count, 0);
  const stops = [];
  let at = 0;
  for (const it of items) {
    const m = META[it.value] || { label: it.value, rule: null, color: "var(--color-grey)" };
    const pct = (it.count / total) * 100;
    stops.push(m.color + " " + at + "% " + (at + pct) + "%");
    at += pct;

    const row = el("div", "legend-item");
    const left = el("div");
    left.style.cssText = "display:flex; align-items:center;";
    const dot = el("span", "dot");
    dot.style.background = m.color;
    dot.style.color = m.color;
    left.appendChild(dot);
    left.appendChild(el("span", null, m.label));
    left.querySelector("span:last-child").style.fontWeight = "600";
    row.appendChild(left);
    const val = el("span", null, nf(it.count));
    val.style.cssText = "font-family:var(--font-mono); font-weight:bold;";
    row.appendChild(val);
    if (m.rule) clickable(row, m.label, () => drawer.open("issue=" + m.rule, m.label));
    legend.appendChild(row);
  }
  donut.style.background = "conic-gradient(" + stops.join(", ") + ")";
}

function renderRules(d) {
  const host = $("#rules-groups-container");
  host.innerHTML = "";
  const RANK = { blocant: 0, avertisment: 1, info: 2, cosmetic: 3 };
  for (const g of d.groups) {
    const card = el("div", "card");
    card.style.cssText = "margin-bottom:24px; padding:0;";
    const head = el("div");
    head.style.cssText = "padding:24px; border-bottom:1px solid var(--border-subtle);";
    const h3 = el("h3", null, g.name);
    h3.style.cssText = "font-size:1.15rem; font-weight:800;";
    head.appendChild(h3);
    card.appendChild(head);

    const items = g.items.slice().sort((a, b) =>
      (RANK[a.severity] - RANK[b.severity]) || (b.count || 0) - (a.count || 0));

    for (const i of items) {
      const row = el("div", "list-row");
      const left = el("div");
      const strong = el("strong", null, i.label);
      strong.style.cssText = "display:block; margin-bottom:4px; font-size:1.02rem;";
      left.appendChild(strong);
      const hint = el("span", null, i.hint || "");
      hint.style.cssText = "font-size:.88rem; color:var(--text-muted);";
      left.appendChild(hint);
      row.appendChild(left);

      const right = el("div");
      right.style.cssText = "display:flex; align-items:center; gap:18px;";
      const sev = el("span", "pill sev-" + i.severity, i.severity === "blocant" ? "grav" : i.severity);
      sev.style.fontSize = ".72rem";
      right.appendChild(sev);
      const cnt = el("span", "row-count" + (i.count ? "" : " zero"), i.measured ? nf(i.count) : "nemăsurat");
      right.appendChild(cnt);
      row.appendChild(right);

      if (i.count > 0) clickable(row, i.label, () => drawer.open("issue=" + encodeURIComponent(i.id), i.label));
      card.appendChild(row);
    }
    host.appendChild(card);
  }
}

// ---------------------------------------------------------------- bulletin
async function loadSummary(force) {
  const box = $("#summary-content");
  const meta = $("#summary-meta");
  box.innerHTML = '<div class="loading">Se scrie…</div>';
  meta.textContent = "";
  const r = await api("/api/summary" + (force ? "?force=1" : ""), null, 180000);
  if (!r.ok || !r.data || r.data.ok === false) {
    box.innerHTML = "";
    box.appendChild(errorBox("Buletinul nu e disponibil", (r.data && r.data.error) || r.error));
    return;
  }
  box.innerHTML = String(r.data.text || "")
    .split(/\n{2,}/)
    .map((p) => "<p style='margin-bottom:12px'>" + esc(p).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>") + "</p>")
    .join("");
  const tok = r.data.tokens ? " · " + ((r.data.tokens.input || 0) + (r.data.tokens.output || 0)) + " tokeni" : "";
  meta.textContent = (r.data.cached ? "din cache · " : "") + (r.data.at ? new Date(r.data.at).toLocaleString("ro-RO") : "") + tok;
}

// ---------------------------------------------------------------- bars
async function loadBars(url, containerId, param, prefix) {
  const c = $("#" + containerId);
  const host = c.parentElement;
  if (host && !host.querySelector(".list-filter")) {
    const wrap = el("div", "list-filter");
    const inp = document.createElement("input");
    inp.type = "search";
    inp.placeholder = "Filtrează lista…";
    inp.addEventListener("input", () => {
      const v = inp.value.trim().toLowerCase();
      for (const row of c.querySelectorAll(".bar-container")) {
        const name = (row.dataset.name || "").toLowerCase();
        row.style.display = !v || name.includes(v) ? "" : "none";
      }
    });
    wrap.appendChild(inp);
    host.insertBefore(wrap, c);
  }
  c.innerHTML = '<div class="loading">Se încarcă…</div>';
  const r = await api(url);
  c.innerHTML = "";
  if (!r.ok || !r.data || !Array.isArray(r.data.items)) {
    c.appendChild(errorBox("Indisponibil", (r.data && r.data.error) || r.error));
    return;
  }
  const items = r.data.items.filter((x) => x.value !== "(neidentificat)");
  if (!items.length) { c.appendChild(el("div", "empty-box", "Fără rezultate.")); return; }
  const max = Math.max.apply(null, items.map((i) => i.count));

  for (const it of items) {
    const box = el("div", "bar-container");
    box.dataset.name = deent(it.value);
    const head = el("div");
    head.style.cssText = "display:flex; justify-content:space-between; font-weight:600; font-size:.98rem; margin-bottom:6px;";
    head.appendChild(el("span", null, deent(it.value)));
    const n = el("span", null, nf(it.count));
    n.style.fontFamily = "var(--font-mono)";
    head.appendChild(n);
    box.appendChild(head);

    const track = el("div", "bar-track");
    const fill = el("div", "bar-fill");
    fill.style.width = "0%";
    track.appendChild(fill);
    box.appendChild(track);

    const acts = el("div", "row-actions");
    const pv = el("button", "mini-btn", "vezi pe peviitor");
    pv.addEventListener("click", (ev) => {
      ev.stopPropagation();
      window.open(pvSearch(deent(it.value)), "_blank", "noopener");
    });
    acts.appendChild(pv);
    box.appendChild(acts);

    clickable(box, deent(it.value), () => drawer.open(param + "=" + encodeURIComponent(it.value), prefix + deent(it.value)));
    c.appendChild(box);
    setTimeout(() => { fill.style.width = Math.max((it.count / max) * 100, 3) + "%"; }, 80);
  }
}

// ---------------------------------------------------------------- sources
async function loadSources() {
  const c = $("#surse-container");
  c.innerHTML = '<div class="loading">Se grupează defectele pe sursă…</div>';
  const r = await api("/api/sources", null, 180000);
  c.innerHTML = "";
  if (!r.ok || !r.data || !Array.isArray(r.data.rows)) {
    c.appendChild(errorBox("Indisponibil", (r.data && r.data.error) || r.error));
    return;
  }
  if (!r.data.rows.length) { c.appendChild(el("div", "empty-box", "Nicio sursă cu peste 100 de joburi.")); return; }

  for (const s of r.data.rows.slice(0, 20)) {
    const card = el("div", "card");
    const head = el("div");
    head.style.cssText = "display:flex; justify-content:space-between; gap:20px; margin-bottom:18px; flex-wrap:wrap;";

    const left = el("div");
    const h3 = el("h3", null, s.host);
    h3.style.cssText = "font-size:1.3rem; margin-bottom:6px; font-weight:800; font-family:var(--font-mono);";
    left.appendChild(h3);
    if (s.diagnostic) {
      const p = el("p", null, s.diagnostic);
      p.style.cssText = "color:var(--text-muted); font-size:.95rem; max-width:60ch;";
      left.appendChild(p);
    }
    head.appendChild(left);

    const col = s.affectedPct > 50 ? "var(--color-red)" : s.affectedPct > 20 ? "var(--color-orange)" : "var(--color-green)";
    const glow = s.affectedPct > 50 ? "var(--glow-red)" : s.affectedPct > 20 ? "var(--glow-orange)" : "var(--glow-green)";
    const right = el("div");
    right.style.cssText = "text-align:right;";
    const big = el("div", null, s.affectedPct + "%");
    big.style.cssText = "font-family:var(--font-mono); font-size:2.4rem; font-weight:900; line-height:1; color:" + col + "; text-shadow:0 0 15px " + glow + ";";
    right.appendChild(big);
    const sub = el("div", null, nf(s.affected) + " din " + nf(s.jobs) + " joburi");
    sub.style.cssText = "font-size:.82rem; color:var(--text-muted); margin-top:6px;";
    right.appendChild(sub);
    head.appendChild(right);
    card.appendChild(head);

    const chips = el("div");
    chips.style.cssText = "display:flex; gap:10px; flex-wrap:wrap;";
    for (const t of s.top) {
      const chip = el("div", "pill sev-" + t.severity);
      chip.appendChild(el("span", null, t.label));
      const n = el("span", null, nf(t.n));
      n.style.cssText = "font-family:var(--font-mono);";
      chip.appendChild(n);
      clickable(chip, t.label + " la " + s.host, (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        drawer.open("issue=" + encodeURIComponent(t.id), t.label + " · " + s.host);
      });
      chips.appendChild(chip);
    }
    card.appendChild(chips);
    c.appendChild(card);
  }
}

// ---------------------------------------------------------------- COR
async function loadOccupations() {
  const stats = $("#ocupatii-stats");
  stats.innerHTML = '<div class="loading">Se potrivesc titlurile cu ocupațiile oficiale…</div>';
  const r = await api("/api/cor", null, 180000);
  stats.innerHTML = "";
  if (!r.ok) {
    stats.appendChild(errorBox("Nemăsurat", "Potrivirea COR nu a rulat încă. Apasă „Reface analiza”."));
    return;
  }
  const d = r.data;
  const mk = (v, label, color) => {
    const c = el("div", "card");
    const x = el("div", "stat-value", v);
    if (color) { x.style.color = color; }
    c.appendChild(x);
    c.appendChild(el("div", "stat-label", label));
    return c;
  };
  stats.appendChild(mk(d.matchedPct + "%", "potrivite cu un cod COR", "var(--color-blue)"));
  stats.appendChild(mk(nf(d.matchedJobs), "joburi potrivite"));
  stats.appendChild(mk(nf(d.distinctTitles), "titluri distincte"));

  const top = $("#ocupatii-top");
  top.innerHTML = "";
  for (const o of (d.topOccupations || []).slice(0, 12)) {
    const row = el("div", "list-row");
    const left = el("div");
    const code = el("span", null, "[" + o.code + "]");
    code.style.cssText = "color:var(--text-subtle); font-family:var(--font-mono); font-size:.85rem; margin-right:12px;";
    left.appendChild(code);
    const nm = el("span", null, o.name);
    nm.style.fontWeight = "600";
    left.appendChild(nm);
    row.appendChild(left);
    row.appendChild(el("span", "row-count", nf(o.count)));
    top.appendChild(row);
  }

  const un = $("#ocupatii-unmatched");
  un.innerHTML = "";
  for (const o of (d.unmatchedTitles || []).slice(0, 12)) {
    const row = el("div", "list-row");
    const nm = el("span", null, deent(o.title));
    nm.style.fontWeight = "600";
    row.appendChild(nm);
    const c = el("span", "row-count", nf(o.count));
    c.style.color = "var(--color-orange)";
    row.appendChild(c);
    un.appendChild(row);
  }
}

// =====================================================================
// pipeline console
// =====================================================================
const term = {
  timer: null,
  open(title) {
    $("#term-title").textContent = title;
    $("#terminal-output").innerHTML = "";
    $("#term-status").textContent = "";
    const m = $("#terminal-modal");
    m.classList.add("open");
    m.setAttribute("aria-hidden", "false");
  },
  close() {
    const m = $("#terminal-modal");
    m.classList.remove("open");
    m.setAttribute("aria-hidden", "true");
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  },
  isOpen() { return $("#terminal-modal").classList.contains("open"); },
  setLines(lines) {
    const out = $("#terminal-output");
    out.innerHTML = "";
    for (const l of lines) {
      const cls = /eroare|error|esuat|failed/i.test(l) ? "err" : /atentie|warn/i.test(l) ? "warn" : "";
      const span = el("span", cls, "> " + l + "\n");
      span.style.display = "block";
      out.appendChild(span);
    }
    out.scrollTop = out.scrollHeight;
  },
};

async function runPipeline() {
  if (!confirm("Reiau analiza pe tot indexul. Continui?")) return;
  term.open("analiză");
  $("#term-status").textContent = "pornesc…";
  const r = await post("/api/pipeline", { confirm: true }, 30000);
  if (!r.ok) { term.setLines(["EROARE: " + r.error]); $("#term-status").textContent = "eșuat"; return; }
  if (r.data && r.data.alreadyRunning) {
    // the automatic run got there first; follow it instead of complaining
    term.setLines(["Analiza rulează deja: " + (r.data.step || "în curs")]);
  }

  let sawStart = false, ticks = 0;
  term.timer = setInterval(async () => {
    ticks++;
    const s = await api("/api/pipeline/status", null, 20000);
    if (!s.ok) return;
    const d = s.data;
    if (Array.isArray(d.lines) && d.lines.length) term.setLines(d.lines);
    if (d.running || d.step) sawStart = true;
    if (d.running) { $("#term-status").textContent = (d.step || "rulează") + " · " + (d.seconds || ticks) + "s"; return; }
    if (!sawStart && ticks < 8) { $("#term-status").textContent = "aștept…"; return; }

    clearInterval(term.timer); term.timer = null;
    $("#term-status").textContent = d.exitCode === 0 ? "gata" : "eșuat";
    if (d.exitCode === 0) setTimeout(() => location.reload(), 2200);
  }, 1000);
}

// =====================================================================
// boot
// =====================================================================
function boot() {
  renderNav();

  $("#btn-close-drawer").addEventListener("click", () => drawer.close());
  $("#drawer-overlay").addEventListener("click", () => drawer.close());
  $("#btn-prev").addEventListener("click", () => { drawer.offset = Math.max(0, drawer.offset - drawer.limit); drawer.load(); });
  $("#btn-next").addEventListener("click", () => { drawer.offset += drawer.limit; drawer.load(); });
  $("#btn-export").addEventListener("click", () => drawer.csv());

  // debounced so a fast typist does not fire a request per keystroke
  let qTimer = null;
  $("#drawer-q").addEventListener("input", (e) => {
    const v = e.target.value.trim();
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      if (v === drawer.term) return;
      drawer.term = v;
      drawer.offset = 0;
      drawer.load();
    }, 350);
  });
  $("#btn-clear-q").addEventListener("click", () => {
    $("#drawer-q").value = "";
    if (!drawer.term) return;
    drawer.term = ""; drawer.offset = 0; drawer.load();
  });
  $("#btn-close-terminal").addEventListener("click", () => term.close());
  $("#btn-pipeline").addEventListener("click", runPipeline);
  $("#btn-refresh-summary").addEventListener("click", () => loadSummary(true));

  const saved = localStorage.getItem("barometru-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  $("#btn-theme").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("barometru-theme", next);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (term.isOpen()) { term.close(); return; }
    if (drawer.isOpen()) drawer.close();
  });

  // a visitor should not be handed a button that will refuse them
  api("/api/auth", null, 15000).then((r) => {
    if (!r.ok || !r.data) return;
    const btn = $("#btn-pipeline");
    if (r.data.autentificat) {
      const out = el("button", "btn", "ieși din cont");
      out.style.cssText = "border-color:var(--border-subtle); color:var(--text-muted);";
      out.onclick = () => { location.href = "/logout"; };
      btn.parentElement.appendChild(out);
      return;
    }
    btn.textContent = "intră ca să reanalizezi";
    btn.title = "Citirea e liberă. Reanaliza apelează modelele, deci cere parolă.";
    btn.onclick = () => { location.href = "/login"; };
  });

  loadTriaj();
  loadSummary(false);
}
document.addEventListener("DOMContentLoaded", boot);
