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


/**
 * A sortable table.
 *
 * The lists used to be rows of coloured bars, which reads well for the top
 * three and badly for everything under it: you cannot compare the eleventh row
 * to the fourth by eye, and the number was smaller than the decoration. A table
 * shows every value at the same size and lets the reader decide the order.
 *
 * cols: [{ key, label, num, width, render(row), sort(row) }]
 * The bar is kept where it earns its place - inside the cell, behind the
 * number, as a share of the largest value in that column.
 */
function dataTable(cols, rows, opts) {
  const o = opts || {};
  const wrap = el("div", "table-wrap");
  const table = el("table", "data-table");
  const thead = el("thead");
  const htr = el("tr");
  let sortKey = o.sortKey || (cols.find((c) => c.num) || cols[0]).key;
  let sortDesc = o.sortDesc !== false;

  const valueOf = (c, r) => (c.sort ? c.sort(r) : r[c.key]);

  for (const c of cols) {
    const th = el("th", c.num ? "num" : null, c.label);
    if (c.width) th.style.width = c.width;
    th.tabIndex = 0;
    const apply = () => {
      if (sortKey === c.key) sortDesc = !sortDesc;
      else { sortKey = c.key; sortDesc = !!c.num; }
      draw();
    };
    th.addEventListener("click", apply);
    th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); apply(); } });
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);
  const tbody = el("tbody");
  table.appendChild(tbody);

  function draw() {
    for (const [i, c] of cols.entries()) {
      const th = htr.children[i];
      th.className = (c.num ? "num" : "") + (sortKey === c.key ? " sorted" : "");
      th.setAttribute("aria-sort", sortKey === c.key ? (sortDesc ? "descending" : "ascending") : "none");
    }
    const col = cols.find((c) => c.key === sortKey);
    const sorted = rows.slice().sort((a, b) => {
      const x = valueOf(col, a), y = valueOf(col, b);
      const d = typeof x === "number" && typeof y === "number"
        ? x - y : String(x == null ? "" : x).localeCompare(String(y == null ? "" : y), "ro");
      return sortDesc ? -d : d;
    });

    const max = {};
    for (const c of cols) {
      if (!c.bar) continue;
      // scaled against every row, not just the visible page, so a bar means the
      // same thing on page 1 and page 40
      max[c.key] = 1;
      for (const r of rows) { const v = Number(valueOf(c, r)) || 0; if (v > max[c.key]) max[c.key] = v; }
    }

    const pages = Math.max(1, Math.ceil(sorted.length / perPage));
    if (page >= pages) page = pages - 1;
    const from = page * perPage;
    const visible = sorted.slice(from, from + perPage);
    prev.disabled = page === 0;
    next.disabled = from + perPage >= sorted.length;
    label.textContent = (sorted.length ? from + 1 : 0) + "–" + Math.min(from + perPage, sorted.length)
      + " din " + nf(sorted.length);

    tbody.innerHTML = "";
    for (const r of visible) {
      const tr = el("tr");
      for (const c of cols) {
        const td = el("td", c.num ? "num" : null);
        if (c.bar) {
          const v = Number(valueOf(c, r)) || 0;
          const cell = el("div", "cell-bar");
          const fill = el("div", "cell-bar-fill");
          fill.style.width = (v / max[c.key]) * 100 + "%";
          if (c.tone) fill.classList.add("tone-" + c.tone(r));
          cell.appendChild(fill);
          cell.appendChild(el("span", null, c.render ? c.render(r) : nf(v)));
          td.appendChild(cell);
        } else if (c.render) {
          const out = c.render(r);
          if (out instanceof Node) td.appendChild(out); else td.textContent = out;
        } else {
          td.textContent = r[c.key] == null ? "—" : String(r[c.key]);
        }
        tr.appendChild(td);
      }
      if (o.onRow) {
        const go = o.onRow(r);
        if (go) clickable(tr, o.rowLabel ? o.rowLabel(r) : "", go);
      }
      tbody.appendChild(tr);
    }
  }
  /**
   * Paging.
   *
   * The company list is 10.679 rows and the whole list is the point: the long
   * tail is where the broken fiscal codes and the duplicate names live. Ten
   * thousand table rows in the document make the tab stutter on every sort, so
   * the rows are all here and only a page of them is in the DOM at a time.
   */
  let page = 0;
  const perPage = o.perPage || 200;
  const foot = el("div", "table-foot");
  const prev = el("button", "btn", "‹ înapoi");
  const next = el("button", "btn", "înainte ›");
  const label = el("span", "table-foot-label");
  prev.addEventListener("click", () => { if (page > 0) { page--; draw(); } });
  next.addEventListener("click", () => { if ((page + 1) * perPage < rows.length) { page++; draw(); } });
  foot.appendChild(prev); foot.appendChild(label); foot.appendChild(next);

  draw();
  wrap.appendChild(table);
  if (rows.length > perPage) wrap.appendChild(foot);
  return wrap;
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
    this.issue = r.data.issue || null;
    $("#drawer-subtitle").textContent = nf(this.total) + " joburi"
      + (this.term ? " care conțin „" + this.term + "”" : "") + " · date reale din producție";
    this.showCompanyLink(r.data);
    this.render();

    const from = this.total ? this.offset + 1 : 0;
    $("#drawer-page").textContent = from + "–" + Math.min(this.offset + this.limit, this.total) + " din " + nf(this.total);
    $("#btn-prev").disabled = this.offset <= 0;
    $("#btn-next").disabled = this.offset + this.limit >= this.total;
  },

  /**
   * When the drawer holds one company, offer its page on peviitor.
   *
   * Their company route is keyed on the fiscal code, not the name: searching
   * "DELOITTE TAX SRL" as text goes through a search that ORs the words and
   * comes back with everything containing "SRL". The CIF is on every row, so
   * the button uses that and lands on the company itself.
   */
  showCompanyLink(data) {
    const old = $("#btn-pv-company");
    if (old) old.remove();
    const isCompany = data && data.filter && data.filter.field === "company";
    if (!isCompany) return;
    const cif = (this.rows.find((x) => x.cif) || {}).cif;
    const head = $("#drawer-header-actions");
    if (!head) return;
    const b = el("button", "btn", cif ? "compania pe peviitor" : "caută compania pe peviitor");
    b.id = "btn-pv-company";
    b.title = cif ? "peviitor.ro/#/company/" + cif : "compania nu are CIF pe niciun rând din pagina asta";
    b.addEventListener("click", () => {
      window.open(cif ? pvCompany(cif) : pvSearch(data.filter.value), "_blank", "noopener");
    });
    head.insertBefore(b, head.firstChild);
  },

  render() {
    const body = $("#drawer-body");
    if (!this.rows.length) {
      body.innerHTML = '<div class="empty-box">Niciun job aici.</div>';
      return;
    }
    let h = "<table><thead><tr><th>Titlu</th><th>Companie</th><th>Locație</th><th>Ce e în neregulă</th></tr></thead><tbody>";
    for (const r of this.rows) {
      h += "<tr>"
        + "<td><a href='" + esc(r.url) + "' target='_blank' rel='noopener'>" + esc(r.title || "(fără titlu)") + "</a>"
        + (r.date ? "<div class='cell-sub'>" + esc(String(r.date).slice(0, 10)) + "</div>" : "")
        + "</td>"
        + "<td>" + esc(deent(r.company)) + (r.cif ? "<div class='cell-sub'>CIF " + esc(r.cif) + "</div>" : "") + "</td>"
        + "<td>" + esc((r.location || []).join(", ") || "—") + "</td>"
        + "<td class='cell-why'>" + esc(whyText(r, this.issue))
        + "<div class='row-actions'>"
        + "<button class='mini-btn' data-pv-q='" + esc(r.title || "") + "'>jobul pe peviitor</button>"
        + (r.cif
            ? "<button class='mini-btn' data-pv-cif='" + esc(r.cif) + "'>compania pe peviitor</button>"
            : "<button class='mini-btn' data-pv-q='" + esc(deent(r.company) || "") + "'>compania pe peviitor</button>")
        + "</div></td>"
        + "</tr>";
    }
    body.innerHTML = h + "</tbody></table>";

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
/**
 * Their company route wants the CIF at its full width, zero-padded to eight
 * digits: /#/company/08119423, not /#/company/8119423. Our documents store it
 * both ways - the peviitor_core contract asks for eight digits without the RO
 * prefix, and plenty of scrapers ignore that - so the padding happens here,
 * once, instead of in every caller.
 */
const pvCompany = (cif) => {
  const digits = String(cif == null ? "" : cif).replace(/^RO/i, "").replace(/\D/g, "");
  const padded = digits.length && digits.length < 8 ? digits.padStart(8, "0") : digits;
  return "https://peviitor.ro/#/company/" + encodeURIComponent(padded);
};

/** a short, row-specific reason, from fields the API already returns */
/**
 * Why THIS row is in THIS list.
 *
 * The column used to run a fixed ladder of checks and print the first one that
 * fired, no matter which rule you had opened. Open "Nume de companie cu HTML
 * nedecodat" on a job whose url is also a relative path and the column said
 * "cale relativă, fără domeniu" - a true sentence about a different problem,
 * which reads as a bug in the dashboard because it is one.
 *
 * So the reason is looked up by rule id, and it shows the offending value
 * rather than restating the rule's own name: seeing `ARRK RESEARCH &amp;
 * DEVELOPMENT SRL` explains the row in a way that "HTML nedecodat" never does.
 */
const WHY = {
  loc_junk:        (r) => quote(loc(r)) + " nu e o localitate",
  loc_country:     (r) => quote(loc(r)) + ", fără localitate",
  loc_international: (r) => quote(loc(r)) + ", în afara României",

  cif_orphan: (r) => "CIF " + (r.cif || "lipsă") + " nu există în catalogul de companii",
  cif_bad_checksum: (r) => "CIF " + quote(r.cif) + " nu trece cifra de control",
  company_html_entity: (r) => quote(mark(r.companyRaw != null ? r.companyRaw : r.company)),

  title_adult:     (r) => quote(hit(r.title, ADULT_WORDS)),
  title_contact:   (r) => quote(hit(r.title, /[\w.+-]+@[\w.-]+|\+?\d[\d ().-]{7,}/)),
  title_too_short: (r) => quote(r.title) + " nu spune ce e jobul",
  title_allcaps:   (r) => quote(r.title),
  dup_title_company: (r) => quote(r.title) + " apare de mai multe ori la " + deent(r.company),

  missing_workmode: () => "câmpul job_type e gol",
  missing_tags:     () => "câmpul hashtags e gol",

  company_not_uppercase: (r) => quote(deent(r.company)) + " nu e scris cu majuscule",
  cif_not_8_digits:  (r) => "CIF " + quote(r.cif) + " are " + String(r.cif || "").replace(/\D/g, "").length + " cifre, nu 8",
  tags_with_diacritics: (r) => quote(tagHit(r, /[ăâîșțĂÂÎȘȚ]/)),
  tags_not_lowercase: (r) => quote(tagHit(r, /[A-ZĂÂÎȘȚ]/)),
  tags_too_many:     (r) => (r.tags || []).length + " etichete, limita e 20",
  workmode_invalid:  (r) => quote(r.workmode) + " nu e remote, on-site sau hybrid",
  status_invalid:    (r) => quote(r.status) + " nu e un status din flux",
  title_too_long:    (r) => String(r.title || "").length + " caractere, limita e 200",
  title_html:        (r) => quote(mark(r.titleRaw != null ? r.titleRaw : r.title)),
  title_untrimmed:   (r) => "spații la capete: " + quote(r.title),
  salary_bad_format: (r) => quote(r.salary) + " nu e „MIN-MAX MONEDĂ”",
  url_broken:        (r) => urlWhy(r.url),
};

const ADULT_WORDS = /videochat|escort[ăa]|masaj erotic|animatoare|adult/i;

const loc = (r) => (r.location || []).join(", ");
const quote = (v) => (v == null || v === "" ? "—" : "„" + String(v) + "”");
/** show the entity itself, not a description of it */
const mark = (v) => String(v == null ? "" : v);
const hit = (text, re) => {
  const m = String(text || "").match(re);
  return m ? m[0] : text;
};
const tagHit = (r, re) => ((r.tags || []).find((t) => re.test(t)) || (r.tags || [])[0] || "");

function urlWhy(u) {
  const s = String(u || "");
  if (!s) return "fără url";
  if (s.startsWith("mailto:")) return "adresă de email, nu anunț";
  if (!/^https?:\/\//i.test(s)) return "cale relativă, fără domeniu";
  if (/\s/.test(s)) return "spațiu în adresă, linkul se rupe";
  return "adresa nu duce la anunț";
}

function whyText(r, issue) {
  const f = WHY[issue];
  if (f) {
    try { const v = f(r); if (v) return v; } catch { /* fall through to the label */ }
  }
  // an issue with no wording of its own gets the rule's own label, which is at
  // least about the right problem
  const rule = state.checks && state.checks.rules.find((x) => x.id === issue);
  return rule ? rule.label : "";
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

  if (id === "locatii" && !state.loaded.locatii) {
    state.loaded.locatii = 1;
    loadBars("/api/top?field=location&limit=20000", "locatii-container", "loc", "Joburi în ", "Localitate");
    loadCountyMap();
  }
  if (id === "companii" && !state.loaded.companii) { state.loaded.companii = 1; loadBars("/api/top?field=company&limit=20000", "companii-container", "company", "Joburi la ", "Companie"); }
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
  renderRuleChart(d);
  renderRules(d);
}

async function renderDonut() {
  const r = await api("/api/top?field=loc_kind&limit=10");
  const legend = $("#donut-legend");
  legend.innerHTML = "";
  if (!r.ok || !r.data || !Array.isArray(r.data.items)) {
    legend.appendChild(errorBox("Distribuția locațiilor", (r.data && r.data.error) || r.error));
    return;
  }
  const META = {
    fixed:         { label: "localitate identificată", rule: null,                cls: "ok" },
    country:       { label: "doar nivel de țară",      rule: "loc_country",       cls: "blue" },
    international: { label: "în afara României",       rule: "loc_international", cls: "warn" },
    junk:          { label: "nu e un loc",             rule: "loc_junk",          cls: "bad" },
  };
  const items = r.data.items.filter((x) => x.count > 0);
  if (!items.length) { legend.appendChild(el("div", "empty-box", "Nemăsurat.")); return; }

  const openKind = (key) => {
    const m = META[key] || { label: key };
    // a slice with a rule opens the rule, so the count matches the rules table;
    // the healthy slice has no rule and opens its jobs directly
    drawer.open(m.rule ? "issue=" + m.rule : "lockind=" + encodeURIComponent(key), m.label);
  };
  Charts.locationDonut($("#chart-locations"), items, META, openKind);

  for (const it of items) {
    const m = META[it.value] || { label: it.value, rule: null, cls: "grey" };
    const row = el("div", "legend-item");
    const left = el("div");
    left.style.cssText = "display:flex; align-items:center;";
    left.appendChild(el("span", "dot dot-" + m.cls));
    const nm = el("span", null, m.label);
    nm.style.fontWeight = "600";
    left.appendChild(nm);
    row.appendChild(left);
    const val = el("span", null, nf(it.count));
    val.style.cssText = "font-family:var(--font-mono);";
    row.appendChild(val);
    clickable(row, m.label, () => openKind(it.value));
    legend.appendChild(row);
  }
}

/** the ten rules that account for the most jobs, as bars that open them */
function renderRuleChart(d) {
  const top = d.rules
    .filter((x) => x.measured && x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  if (!top.length) return;
  Charts.ruleBars($("#chart-rules"), top, (id, label) =>
    drawer.open("issue=" + encodeURIComponent(id), label));
}

function renderRules(d) {
  const host = $("#rules-groups-container");
  host.innerHTML = "";
  const RANK = { blocant: 0, avertisment: 1, info: 2, cosmetic: 3 };
  const WORD = { blocant: "grav", avertisment: "avertisment", info: "info", cosmetic: "cosmetic" };

  for (const g of d.groups) {
    const card = el("div", "card");
    card.style.cssText = "margin-bottom:24px; padding:0;";
    const head = el("div");
    head.style.cssText = "padding:20px 24px; border-bottom:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:baseline; gap:16px;";
    const h3 = el("h3", null, g.name);
    h3.style.cssText = "font-size:1.05rem; font-weight:700;";
    head.appendChild(h3);
    const firing = g.items.filter((i) => i.measured && i.count > 0).length;
    const note = el("span", null, firing + " din " + g.items.length + " verificări găsesc ceva");
    note.style.cssText = "font-size:.8rem; color:var(--text-muted);";
    head.appendChild(note);
    card.appendChild(head);

    card.appendChild(dataTable([
      {
        key: "label", label: "Verificare",
        render: (i) => {
          const box = el("div");
          const b = el("div", "cell-title", i.label);
          box.appendChild(b);
          if (i.hint) box.appendChild(el("div", "cell-hint", i.hint));
          return box;
        },
      },
      {
        key: "severity", label: "Gravitate", width: "130px",
        sort: (i) => RANK[i.severity],
        render: (i) => {
          const p = el("span", "pill sev-" + i.severity, WORD[i.severity] || i.severity);
          p.style.fontSize = ".72rem";
          return p;
        },
      },
      {
        key: "count", label: "Joburi", num: true, width: "110px",
        sort: (i) => (i.measured ? i.count : -1),
        render: (i) => (i.measured ? nf(i.count) : "nemăsurat"),
      },
      {
        key: "pct", label: "Din total", num: true, width: "100px",
        sort: (i) => (i.pct == null ? -1 : i.pct),
        render: (i) => (i.pct == null ? "—" : i.pct + "%"),
      },
    ], g.items, {
      sortKey: "count",
      onRow: (i) => (i.count > 0 ? () => drawer.open("issue=" + encodeURIComponent(i.id), i.label) : null),
      rowLabel: (i) => i.label,
    }));
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
async function loadBars(url, containerId, param, prefix, colLabel) {
  const c = $("#" + containerId);
  c.innerHTML = '<div class="loading">Se încarcă…</div>';
  const r = await api(url);
  c.innerHTML = "";
  if (!r.ok || !r.data || !Array.isArray(r.data.items)) {
    c.appendChild(errorBox("Indisponibil", (r.data && r.data.error) || r.error));
    return;
  }
  const items = r.data.items.filter((x) => x.value !== "(neidentificat)");
  if (!items.length) { c.appendChild(el("div", "empty-box", "Fără rezultate.")); return; }

  const total = state.checks ? state.checks.total : items.reduce((a, b) => a + b.count, 0);
  const rows = items.map((it) => ({
    name: deent(it.value), raw: it.value, count: it.count,
    pct: total ? +((it.count / total) * 100).toFixed(2) : null,
  }));

  const filter = el("div", "list-filter");
  const inp = document.createElement("input");
  inp.type = "search";
  inp.placeholder = "Filtrează lista…";
  filter.appendChild(inp);
  c.appendChild(filter);

  const holder = el("div");
  c.appendChild(holder);

  const chartNode = document.getElementById(containerId === "locatii-container" ? "chart-top-locations" : "chart-top-companies");
  if (chartNode) {
    Charts.topBars(chartNode, rows, (raw, name) =>
      drawer.open(param + "=" + encodeURIComponent(raw), prefix + name));
  }

  const build = (data) => {
    holder.innerHTML = "";
    holder.appendChild(dataTable([
      { key: "name", label: colLabel },
      { key: "count", label: "Joburi", num: true, bar: true },
      { key: "pct", label: "Din total", num: true, render: (x) => (x.pct == null ? "—" : x.pct + "%") },
    ], data, {
      sortKey: "count",
      onRow: (x) => () => drawer.open(param + "=" + encodeURIComponent(x.raw), prefix + x.name),
      rowLabel: (x) => prefix + x.name,
    }));
  };
  build(rows);
  inp.addEventListener("input", () => {
    const v = inp.value.trim().toLowerCase();
    build(v ? rows.filter((x) => x.name.toLowerCase().includes(v)) : rows);
  });
}

/** Romania by county; a county opens the jobs that sit in it */
async function loadCountyMap() {
  const node = $("#chart-county-map");
  const r = await api("/api/top?field=county");
  if (!r.ok || !r.data || !Array.isArray(r.data.items) || !r.data.items.length) {
    node.innerHTML = "";
    node.appendChild(errorBox("Harta pe județe", (r.data && r.data.error) || r.error || "registrul SIRUTA lipseste"));
    return;
  }
  try {
    await Charts.countyMap(node, r.data.items, (county) =>
      drawer.open("county=" + encodeURIComponent(county), "Joburi în județul " + county));
  } catch (e) {
    node.innerHTML = "";
    node.appendChild(errorBox("Harta pe județe", e.message));
  }
}

// ---------------------------------------------------------------- sources
async function loadSources() {
  const c = $("#surse-container");
  c.innerHTML = '<div class="loading">Se grupează defectele pe sursă…</div>';
  const r = await api("/api/sources", null, 180000);
  c.innerHTML = "";
  const heatNode = $("#chart-heatmap");
  if (!r.ok || !r.data || !Array.isArray(r.data.rows)) {
    c.appendChild(errorBox("Indisponibil", (r.data && r.data.error) || r.error));
    return;
  }
  if (!r.data.rows.length) { c.appendChild(el("div", "empty-box", "Nicio sursă cu peste 100 de joburi.")); return; }

  const labelOf = (id) => {
    const rule = state.checks && state.checks.rules.find((x) => x.id === id);
    return rule ? rule.label : id;
  };
  Charts.sourceStacks(heatNode, r.data.rows.slice(0, 20), labelOf, (id, host, label) =>
    drawer.open("issue=" + encodeURIComponent(id) + "&host=" + encodeURIComponent(host),
      label + " · " + host));

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
        drawer.open("issue=" + encodeURIComponent(t.id) + "&host=" + encodeURIComponent(s.host),
          t.label + " · " + s.host);
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

  Charts.occupationTreemap($("#chart-occupations"),
    (d.topOccupations || []).slice(0, 24).map((o) => ({ name: o.name, count: o.count, code: o.code })),
    (code, name) => drawer.open("cor=" + encodeURIComponent(code), name));

  const top = $("#ocupatii-top");
  top.innerHTML = "";
  top.appendChild(dataTable([
    { key: "code", label: "Cod", width: "90px", render: (o) => el("span", "mono-dim", o.code) },
    { key: "name", label: "Ocupație" },
    { key: "count", label: "Joburi", num: true, bar: true, width: "160px" },
  ], (d.topOccupations || []).slice(0, 25), {
    sortKey: "count",
    onRow: (o) => () => drawer.open("cor=" + encodeURIComponent(o.code), o.name),
    rowLabel: (o) => o.name,
  }));

  const un = $("#ocupatii-unmatched");
  un.innerHTML = "";
  un.appendChild(dataTable([
    { key: "title", label: "Titlu", render: (o) => deent(o.title) },
    { key: "count", label: "Joburi", num: true, bar: true, width: "160px", tone: () => "warn" },
  ], (d.unmatchedTitles || []).slice(0, 60), {
    sortKey: "count",
    onRow: (o) => () => drawer.open("title=" + encodeURIComponent(o.title), deent(o.title)),
    rowLabel: (o) => deent(o.title),
  }));
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

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (drawer.isOpen()) drawer.close();
  });

  loadTriaj();
  loadSummary(false);
}
document.addEventListener("DOMContentLoaded", boot);
