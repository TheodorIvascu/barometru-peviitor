"use strict";
/* BAROMETRU frontend. Six screens, one drawer. Every number opens. */

const $ = (s, el) => (el || document).querySelector(s);
const fmt = (n) => (n == null ? "–" : Number(n).toLocaleString("ro-RO"));
const pct = (n) => (n == null ? "–" : Number(n).toLocaleString("ro-RO", { maximumFractionDigits: 0 }) + "%");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[șş]/gi, "s").replace(/[țţ]/gi, "t").toLowerCase().trim();
const COLORS = ["#2dd4bf", "#38bdf8", "#a78bfa", "#f472b6", "#fbbf24", "#34d399", "#fb923c", "#60a5fa", "#e879f9", "#4ade80"];
const OWNER = { core: "peviitor_core", scraper: "scraper" };

const state = { run: null, geo: null, charts: [], pollTimer: null };

// ---- data -------------------------------------------------------------------------
async function loadRun() {
  const r = await (await fetch("/api/run")).json();
  state.run = r;
  renderFoot();
  renderBanner();
  route();
  clearTimeout(state.pollTimer);
  if (r.running) state.pollTimer = setTimeout(loadRun, 5000);
}

function renderBanner() {
  const b = $("#banner");
  const r = state.run;
  if (r.running) {
    const p = r.progress || {};
    const det = p.step === "jobs" ? `${fmt(p.scanned)} anunțuri procesate` : p.step === "links" ? `${fmt(p.done)} din ${fmt(p.of)} adrese verificate` : p.step === "companies" ? `${fmt(p.scanned)} companii procesate` : p.step || "";
    b.textContent = `Analiză în curs · ${det}. ${r.summary ? "Valorile afișate provin din analiza anterioară." : ""}`;
    b.className = "banner"; b.hidden = false;
  } else if (r.error && r.summary) {
    // avem date bune; a eșuat doar reîmprospătarea. Nu e o alarmă.
    const cand = new Date(r.summary.runAt).toLocaleString("ro-RO", { dateStyle: "medium", timeStyle: "short" });
    b.textContent = `Reîmprospătarea datelor nu a reușit (${r.error}). Valorile afișate provin din analiza de la ${cand}. Se reîncearcă automat.`;
    b.className = "banner"; b.hidden = false;
  } else if (r.error) {
    b.textContent = "Analiza nu a putut fi efectuată: " + r.error; b.className = "banner err"; b.hidden = false;
  } else if (r.source === "seed") {
    b.textContent = "Valorile provin din analiza livrată împreună cu aplicația. Listele de anunțuri devin disponibile după prima analiză efectuată în acest mediu."; b.className = "banner"; b.hidden = false;
  } else b.hidden = true;
}

function renderFoot() {
  const s = state.run.summary;
  const el = $("#side-foot");
  if (!s) { el.innerHTML = "Nu există nicio analiză."; el.removeAttribute("title"); return; }
  el.innerHTML = `<span class="hasnote">Analiză din ${new Date(s.runAt).toLocaleString("ro-RO", { dateStyle: "medium", timeStyle: "short" })}</span><br>${fmt(s.totals.jobs)} anunțuri · ${fmt(s.totals.companies)} companii<br>acces în citire · rulare zilnică`;
  // ultimele rulări, ca tooltip nativ: fără dependențe și fără poziționare de întreținut
  const runs = (s.recentRuns || []).slice(0, 3);
  el.title = runs.length
    ? "Ultimele analize\n" + runs.map((r) => {
        const d = new Date(r.runAt).toLocaleString("ro-RO", { dateStyle: "short", timeStyle: "short" });
        const intr = r.incoming ? `, ${fmt(r.incoming.jobs)} intrate / ${fmt(r.incoming.gone)} dispărute` : "";
        return `${d} · ${fmt(r.trusted)} valide din ${fmt(r.jobs)}${intr}`;
      }).join("\n")
    : "Prima analiză; istoricul apare de la a doua.";
}

// ---- helpers ------------------------------------------------------------------------
function card(title, body, foot) {
  return `<div class="card">${title ? `<h2>${esc(title)}</h2>` : ""}${body}${foot ? `<div class="foot">${foot}</div>` : ""}</div>`;
}
function kpi(v, l, filter, title) {
  const f = filter ? ` data-jobs='${esc(JSON.stringify(filter))}' data-title="${esc(title || l)}"` : "";
  return `<div class="card kpi${filter ? " click" : ""}"${f}><div class="v">${v}</div><div class="l">${esc(l)}</div></div>`;
}
const badge = (sev, text) => `<span class="badge ${esc(sev)}">${esc(text || sev)}</span>`;
const bar = (p, red) => `<div class="bar${red ? " red" : ""}"><i style="width:${Math.min(100, p)}%"></i></div>`;
const ofTotal = (n, total) => `${fmt(n)} <span class="muted">din ${fmt(total)}</span>`;

/** cols: [{h, k|f, cls}]; a column with neither k nor f reads r[index] */
function table(cols, rows, rowFilter, rowTitle) {
  const head = cols.map((c) => `<th class="${c.cls || ""}">${esc(c.h)}</th>`).join("");
  const body = rows.map((r) => {
    const f = rowFilter && rowFilter(r);
    const attrs = f ? ` class="row" data-jobs='${esc(JSON.stringify(f))}' data-title="${esc(rowTitle ? rowTitle(r) : "")}"` : "";
    return `<tr${attrs}>${cols.map((c, i) => `<td class="${c.cls || ""}">${c.f ? c.f(r) : esc(c.k != null ? r[c.k] : r[String(i)])}</td>`).join("")}</tr>`;
  }).join("");
  return `<div class="scroll"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${cols.length}" class="empty">nu există date</td></tr>`}</tbody></table></div>`;
}

/** the standard rule table used on Probleme and Abateri de format */
function checksTable(list, total) {
  return table([
    { h: "Regulă", f: (r) => `<div title="${esc(r.why)}">${esc(r.label)}</div><div class="contract">${esc(r.contract)}</div>` },
    { h: "De corectat", cls: "wrap", f: (r) => r.fix ? `<div class="fixnote">${esc(r.fix)}</div>` : `<span class="muted">–</span>` },
    { h: "Valori identificate", cls: "wrap", f: (r) => r.samples.length ? r.samples.map((x) => `<div class="ev">${esc(x.value)}</div>`).join("") : `<span class="muted">–</span>` },
    { h: "Anunțuri", cls: "num", f: (r) => ofTotal(r.count, total) },
    { h: "", f: (r) => bar(100 * r.count / total, r.severity === "grav") },
    { h: "Responsabil", f: (r) => badge(r.owner, OWNER[r.owner]) },
    { h: "Surse principale", f: (r) => r.topHosts.map((h) => `<div class="muted">${esc(h.host)} <b>${fmt(h.jobs)}</b></div>`).join("") || `<span class="muted">–</span>` },
  ], list, (r) => (r.count ? { check: r.id } : null), (r) => r.label);
}

function disposeCharts() { for (const c of state.charts) c.dispose(); state.charts = []; }
function chart(el, option, onClick) {
  if (!el) return null;
  const c = echarts.init(el, null, { renderer: "canvas" });
  c.setOption(Object.assign({ backgroundColor: "transparent", textStyle: { color: "#e6edf3", fontFamily: "system-ui, sans-serif" }, color: COLORS }, option));
  if (onClick) c.on("click", onClick);
  state.charts.push(c);
  return c;
}
window.addEventListener("resize", () => state.charts.forEach((c) => c.resize()));

const axis = { axisLine: { lineStyle: { color: "#263040" } }, axisLabel: { color: "#8b98a8" }, splitLine: { lineStyle: { color: "#1c242e" } } };
const tooltip = { trigger: "item", backgroundColor: "#1c242e", borderColor: "#263040", textStyle: { color: "#e6edf3" } };

function hbar(el, items, labelKey, valueKey, onItem, color) {
  const data = items.slice().reverse();
  chart(el, {
    tooltip: { ...tooltip, formatter: (p) => `${esc(p.name)}<br><b>${fmt(p.value)}</b> anunțuri` },
    grid: { left: 8, right: 60, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: "value", ...axis },
    yAxis: { type: "category", data: data.map((d) => String(d[labelKey]).length > 38 ? String(d[labelKey]).slice(0, 36) + "…" : d[labelKey]), ...axis, axisLabel: { color: "#c9d3de", fontSize: 12 } },
    series: [{ type: "bar", data: data.map((d) => d[valueKey]), itemStyle: { color: color || "#2dd4bf", borderRadius: [0, 4, 4, 0] }, barMaxWidth: 22,
      label: { show: true, position: "right", color: "#8b98a8", formatter: (p) => fmt(p.value) } }],
  }, (p) => onItem && onItem(data[p.dataIndex]));
}

function donut(el, items, labelKey, valueKey, onItem) {
  chart(el, {
    tooltip: { ...tooltip, formatter: (p) => `${esc(p.name)}<br><b>${fmt(p.value)}</b> · ${pct(p.percent)}` },
    legend: { orient: "vertical", right: 10, top: "middle", textStyle: { color: "#c9d3de" } },
    series: [{ type: "pie", radius: ["48%", "72%"], center: ["35%", "50%"], avoidLabelOverlap: true, label: { show: false },
      itemStyle: { borderColor: "#161c24", borderWidth: 2 },
      data: items.map((d) => ({ name: d[labelKey], value: d[valueKey] })) }],
  }, (p) => onItem && onItem(items[p.dataIndex]));
}

/** codurile HTTP întâlnite, pentru o categorie: "404 × 12, 410 × 1" */
function codesFor(codes, kind) {
  if (!codes || kind === "ok" || kind === "unreachable") return "";
  const mort = (c) => c === 404 || c === 410;
  return Object.entries(codes)
    .filter(([c]) => { const n = Number(c); return n >= 400 && (kind === "dead" ? mort(n) : !mort(n)); })
    .sort((p, q) => q[1] - p[1])
    .map(([c, n]) => c + " × " + fmt(n))
    .join(", ");
}

/**
 * Schimbarea față de rularea anterioară, scrisă în cuvinte.
 * scadereEBuna: true când o scădere e un lucru bun (neconformități), false când
 * e rea (anunțuri valide), null când nu are conotație (mărimea indexului).
 */
function schimbare(acum, inainte, scadereEBuna) {
  if (inainte == null) return "";
  const d = acum - inainte;
  if (!d) return `<span class="muted">la fel</span>`;
  const cuvant = d > 0 ? "mai multe" : "mai puține";
  const clasa = scadereEBuna === null ? "" : (scadereEBuna ? (d < 0 ? "up" : "down") : (d > 0 ? "up" : "down"));
  return `<span class="${clasa}">${fmt(Math.abs(d))} ${cuvant}</span>`;
}

/**
 * Ce a intrat de la ultima analiză. Câmpul `date` din index este data ultimei
 * extrageri, nu a primei apariții, deci intrările se urmăresc separat.
 */
function incomingBlock(s) {
  const inc = s.incoming;
  if (!inc) return "";
  if (inc.baseline) {
    return `<div class="section"><h2>Intrări</h2><span class="note">prima analiză a stabilit linia de plecare pentru ${fmt(inc.tracked)} de anunțuri; intrările se raportează de la analiza următoare</span></div>`;
  }
  const w = inc.window;
  if (!w || !w.jobs) {
    return `<div class="section"><h2>Intrări</h2><span class="note">niciun anunț nou de la ultima analiză</span></div>`;
  }
  const zile = w.partial
    ? `de la ${new Date(w.from).toLocaleDateString("ro-RO", { day: "numeric", month: "long" })}, de când urmărim intrările`
    : `în ultimele ${w.days} zile`;
  const worst = w.hosts.slice(0, 8);
  return `
    <div class="section"><h2>Ce a intrat ${zile}</h2><span class="note">${fmt(w.jobs)} anunțuri noi, dintre care ${fmt(w.affected)} neconforme · de la ultima analiză: ${fmt(inc.jobs)} intrate, ${fmt(inc.gone)} dispărute</span></div>
    <div class="grid c2">
      ${card("Intrări pe zi", `<div class="chart short" id="ch-intrari"></div>`, "bara plină sunt anunțurile neconforme · selectați o zi")}
      ${card("Ce aduc anunțurile noi", table([
        { h: "Neconformitate", f: (r) => esc(r.label) },
        { h: "Anunțuri", cls: "num", f: (r) => fmt(r.count) },
      ], w.checks.slice(0, 8), (r) => ({ check: r.id, zile: String(w.days) }), (r) => r.label + " · anunțuri intrate recent"),
        `numărate pe cele intrate ${zile}`)}
    </div>
    ${card("Surse care au adus anunțuri noi", table([
      { h: "Sursă", f: (r) => `<a class="cell-link" href="#/sursa/${encodeURIComponent(r.host)}"><b>${esc(r.host)}</b></a>` },
      { h: "Noi", cls: "num", f: (r) => fmt(r.window) },
      { h: "Neconforme", cls: "num", f: (r) => r.windowAffected ? `<span class="cell-link" data-jobs='${esc(JSON.stringify({ host: r.host, zile: String(w.days), neconform: "1" }))}' data-title="${esc(r.host + " · anunțuri noi")}">${fmt(r.windowAffected)}</span>` : `<span class="muted">0</span>` },
      { h: "", cls: "num", f: (r) => r.windowAffected ? pct(r.pct) : "" },
      { h: "", f: (r) => bar(r.pct, r.pct >= 50) },
    ], worst, (r) => ({ host: r.host, zile: String(w.days) }), (r) => r.host + " · anunțuri noi"),
      `${fmt(w.jobs)} anunțuri noi de la ${w.hosts.length} surse · selectați un rând pentru listă`)}`;
}

// ---- screens ----------------------------------------------------------------------------
const screens = {
  overview() {
    const s = state.run.summary;
    const t = s.totals;
    const tr = s.trend;
    const qs = s.questions.filter((q) => q.id !== "format");
    const worst = s.checks.filter((c) => c.severity === "grav" && c.count).sort((a, b) => b.count - a.count);
    const fmtQ = s.questions.find((q) => q.id === "format");
    return `
      <h1>Sinteză</h1>
      <p class="sub">Un anunț este considerat valid dacă postul mai este disponibil și dacă datele publicate sunt corecte. Selectați orice valoare pentru a consulta anunțurile corespunzătoare.</p>
      <div class="hero" data-jobs='{"trusted":"1"}' data-title="Anunțuri valide" style="cursor:pointer">
        <div>
          <div class="n">${fmt(t.trusted)} <small>din ${fmt(t.jobs)}</small></div>
          <div class="l">anunțuri valide din index</div>
        </div>
        <div class="trend">${tr
          ? `<div>față de acum ${tr.days} ${tr.days === 1 ? "zi" : "zile"}, pe ${new Date(tr.since).toLocaleDateString("ro-RO", { day: "numeric", month: "long" })}</div><div class="trend-linii"><span>anunțuri valide</span><b>${schimbare(t.trusted, tr.totals.trusted, false)}</b><span>anunțuri în index</span><b>${schimbare(t.jobs, tr.totals.jobs, null)}</b></div>`
          : `prima analiză; evoluția va fi disponibilă începând de mâine`}</div>
      </div>
      ${incomingBlock(s)}
      <div class="section"><h2>Neconformități</h2><span class="note">${fmt(t.affected)} din ${fmt(t.jobs)} anunțuri nu îndeplinesc cel puțin unul dintre cele două criterii</span></div>
      <div class="q">
        ${qs.map((q) => `
          <div class="qcard" data-jobs='${esc(JSON.stringify({ question: q.id }))}' data-title="${esc(q.label)}">
            <div class="n">${fmt(q.affected)} <small>din ${fmt(t.jobs)}</small></div>
            <div class="t">${esc(q.label)}</div>
            <div class="d">${esc(q.why)}</div>
            <div class="o">${tr ? `<span class="qtrend">${schimbare(q.affected, (tr.questions.find((x) => x.id === q.id) || {}).affected, true)} față de acum ${tr.days} ${tr.days === 1 ? "zi" : "zile"}</span> · ` : ""}responsabil: ${badge(q.owner === "peviitor_core" ? "core" : "scraper", q.owner)}</div>
          </div>`).join("")}
      </div>
      <div class="grid c2">
        ${card("Neconformități majore", table([
          { h: "Neconformitate", f: (r) => `<div title="${esc(r.why)}">${esc(r.label)}</div>${r.samples.slice(0, 2).map((x) => `<div class="ev">${esc(x.value)}</div>`).join("")}` },
          { h: "Anunțuri", cls: "num", f: (r) => ofTotal(r.count, t.jobs) },
          { h: "Responsabil", f: (r) => badge(r.owner, OWNER[r.owner]) },
        ], worst, (r) => ({ check: r.id }), (r) => r.label), `<a href="#/probleme">toate regulile de verificare →</a> · <a href="#/format">abateri de format: ${fmt(fmtQ.affected)} anunțuri, fără efect asupra utilizatorului →</a>`)}
        <div>
          ${card("Vechimea anunțurilor", `<div class="chart short" id="ch-fresh"></div>`, "calculată de la data extragerii din sursă")}
          ${card("Mod de lucru", `<div class="chart short" id="ch-wm"></div>`)}
        </div>
      </div>`;
  },

  probleme() {
    const s = state.run.summary;
    const t = s.totals.jobs;
    return `
      <h1>Neconformități</h1>
      <p class="sub">Regulile care invalidează un anunț, grupate pe cele două criterii. Selectați un rând pentru a consulta anunțurile.</p>
      ${s.questions.filter((q) => q.id !== "format").map((q) => `
        <div class="section"><h2>${esc(q.label)}</h2><span class="note">${fmt(q.affected)} din ${fmt(t)} anunțuri · ${esc(q.why)}</span></div>
        ${card(null, checksTable(s.checks.filter((c) => c.question === q.id).sort((a, b) => b.count - a.count), t))}`).join("")}
      <p class="note" style="margin-top:18px">Disponibilitatea adreselor este verificată pe un eșantion de ${s.links ? s.links.perHost : 15} adrese pentru fiecare sursă, nu pe întregul index. Abaterile de format sunt prezentate separat, la <a href="#/format">Abateri de format</a>.</p>`;
  },

  format() {
    const s = state.run.summary;
    const t = s.totals.jobs;
    const q = s.questions.find((x) => x.id === "format");
    const list = s.checks.filter((c) => c.question === "format").sort((a, b) => b.count - a.count);
    const masurate = s.checks.filter((c) => c.severity === "info" && c.count).sort((a, b) => b.count - a.count);
    return `
      <h1>Abateri de format</h1>
      <p class="sub">Abateri de la contractul peviitor_core fără efect vizibil pentru utilizator. Nu invalidează anunțul, dar indică sursele care necesită corecții.</p>
      <div class="section"><h2>Abateri de format</h2><span class="note">${fmt(q.affected)} din ${fmt(t)} anunțuri prezintă cel puțin o abatere</span></div>
      ${card(null, checksTable(list, t))}
      <div class="section"><h2>Indicatori măsurați</h2><span class="note">valori urmărite pentru evoluția lor în timp; nu constituie neconformități și nu influențează numărul de anunțuri valide</span></div>
      ${card(null, checksTable(masurate, t))}`;
  },

  harta() {
    const s = state.run.summary;
    const m = s.map;
    const u = m.unplaced;
    return `
      <h1>Hartă</h1>
      <p class="sub">Repartizarea pe județe a anunțurilor valide. Anunțurile invalidate nu sunt reprezentate pe hartă; motivele sunt prezentate alăturat.</p>
      <div class="grid map">
        ${card(null, `<div class="chart tall" id="ch-map"></div>`, `${fmt(m.placed)} din ${fmt(m.basis)} anunțuri valide · selectați un județ`)}
        <div>
          ${card("Anunțuri nereprezentate pe hartă", table([{ h: "Motiv" }, { h: "Anunțuri", cls: "num" }], [
            { k: "foreign", l: "în afara României", n: u.foreign },
            { k: "placeholder", l: "valoare generică (Romania, Remote)", n: u.placeholder },
            { k: "gibberish", l: "nerecunoscută", n: u.gibberish },
            { k: "empty", l: "locație necompletată", n: u.empty },
            { k: "ambiguous", l: "localitate omonimă în mai multe județe", n: u.ambiguous },
          ].map((r) => ({ ...r, "0": r.l, "1": fmt(r.n) })), (r) => (r.n ? { loc: r.k } : null), (r) => r.l), "valori calculate pe întregul index")}
          ${card("Localități cu cele mai multe anunțuri", `<div class="chart" style="height:${Math.max(220, 22 * Math.min(15, m.topLocalities.length))}px" id="ch-loc"></div>`)}
        </div>
      </div>
      <div class="grid c2">
        ${card("Localități din afara României", table([{ h: "Localitate" }, { h: "Anunțuri", cls: "num" }], m.topForeign.map((r) => ({ ...r, "0": r.place, "1": fmt(r.jobs) })), (r) => ({ place: r.place }), (r) => r.place))}
        ${card("Locații nerecunoscute", table([{ h: "Valoare din anunț", cls: "wrap" }, { h: "Anunțuri", cls: "num" }], m.topUnplaced.map((r) => ({ ...r, "0": r.raw, "1": fmt(r.jobs) })), (r) => ({ rawloc: r.raw === "(gol)" ? "" : r.raw, loc: r.raw === "(gol)" ? "empty" : undefined }), (r) => "Locație: " + r.raw))}
      </div>`;
  },

  companii() {
    const s = state.run.summary;
    const c = s.companies;
    const o = s.occupations;
    return `
      <h1>Companii și ocupații</h1>
      <p class="sub">Distribuția pe angajatori și pe denumiri de post, calculată pe cele ${fmt(c.basis)} anunțuri valide. Clasificarea pe ocupații COR va fi disponibilă într-o versiune ulterioară.</p>
      <div class="grid k4">
        ${kpi(fmt(c.distinctInTrusted), "companii cu anunțuri valide")}
        ${kpi(fmt(c.catalogWithoutJobs), "companii din catalog fără anunțuri")}
        ${kpi(fmt(c.notActiveJobs), "anunțuri ale companiilor inactive fiscal", { check: "company_not_active" }, "Companii declarate inactive fiscal")}
        ${kpi(fmt(c.orphanJobs), "anunțuri cu CIF fără corespondent în catalog", { check: "cif_orphan" }, "CIF fără companie în catalog")}
      </div>
      <div class="grid c2">
        ${card("Companii cu cele mai multe anunțuri", `<div class="chart" style="height:560px" id="ch-co"></div>`, "selectați o valoare")}
        <div>
          ${card("Distribuția companiilor după numărul de anunțuri", `<div class="chart short" id="ch-size"></div>`)}
          ${card("Statusul companiilor din catalog", table([{ h: "Status" }, { h: "Companii", cls: "num" }], c.status.map((r) => ({ "0": r.value, "1": fmt(r.jobs) })), null), "contractul permite exclusiv valorile activ, suspendat, inactiv și radiat")}
        </div>
      </div>
      <div class="grid c2">
        ${card("Cele mai frecvente denumiri de post", table([{ h: "Denumire post", cls: "wrap" }, { h: "Anunțuri", cls: "num" }], o.topTitles.map((r) => ({ ...r, "0": r.title, "1": fmt(r.jobs) })), (r) => ({ title: r.title, trusted: "1" }), (r) => r.title))}
        ${card("Cele mai frecvente etichete", table([{ h: "Etichetă" }, { h: "Anunțuri", cls: "num" }], o.topTags.map((r) => ({ ...r, "0": r.tag, "1": fmt(r.jobs) })), (r) => ({ tag: r.tag, trusted: "1" }), (r) => "Etichetă: " + r.tag))}
      </div>`;
  },

  sursa() {
    const s = state.run.summary;
    const host = state.host;
    const r = s.sources.find((x) => x.host === host);
    if (!r) return `<h1>${esc(host)}</h1><p class="sub">Sursa nu apare în ultima analiză. <a href="#/surse">Înapoi la surse</a></p>`;

    const byId = new Map(s.checks.map((c) => [c.id, c]));
    const incalcate = Object.entries(r.byCheck)
      .map(([id, n]) => ({ ...byId.get(id), count: n }))
      .filter((c) => c.id && c.severity !== "info")
      .sort((x, y) => (x.severity === y.severity ? y.count - x.count : x.severity === "grav" ? -1 : 1));
    const grave = incalcate.filter((c) => c.severity === "grav");
    const format = incalcate.filter((c) => c.severity === "minor");
    const masurate = Object.entries(r.byCheck).map(([id, n]) => ({ ...byId.get(id), count: n })).filter((c) => c.id && c.severity === "info");

    const tabel = (list) => table([
      { h: "Neconformitate", f: (c) => `<div title="${esc(c.why)}">${esc(c.label)}</div><div class="contract">${esc(c.contract)}</div>` },
      { h: "De corectat", cls: "wrap", f: (c) => c.fix ? `<div class="fixnote">${esc(c.fix)}</div>` : `<span class="muted">–</span>` },
      { h: "Anunțuri", cls: "num", f: (c) => `${fmt(c.count)} <span class="muted">din ${fmt(r.jobs)}</span>` },
      { h: "", f: (c) => bar(100 * c.count / r.jobs, c.severity === "grav") },
      { h: "Responsabil", f: (c) => badge(c.owner, OWNER[c.owner]) },
    ], list, (c) => ({ host, check: c.id }), (c) => host + " · " + c.label);

    const l = r.links;
    return `
      <p class="crumb"><a href="#/surse">← toate sursele</a></p>
      <h1>${esc(host)}</h1>
      <p class="sub">Toate neconformitățile anunțurilor extrase de pe acest site, cu ce trebuie schimbat pentru fiecare. Selectați un rând pentru a vedea anunțurile.</p>
      <div class="grid k4">
        ${kpi(fmt(r.jobs), "anunțuri în index", { host }, host)}
        ${kpi(fmt(r.trusted), "valide", { host, trusted: "1" }, host + " · anunțuri valide")}
        ${kpi(r.fresh ? fmt(r.fresh) : "0", "intrate de la ultima analiză", r.fresh ? { host, nou: "1" } : null, host + " · anunțuri noi")}
        ${kpi(pct(r.pct), "neconforme")}
      </div>
      ${grave.length ? `<div class="section"><h2>Neconformități majore</h2><span class="note">${fmt(r.affected)} din ${fmt(r.jobs)} anunțuri ale acestei surse nu îndeplinesc cel puțin un criteriu</span></div>${card(null, tabel(grave))}` : `<div class="section"><h2>Neconformități majore</h2><span class="note">niciuna</span></div>`}
      ${l ? `<div class="section"><h2>Verificarea adreselor</h2><span class="note">eșantion de ${fmt(l.sampled)} adrese de pe acest site</span></div>
      ${card(null, table([{ h: "Rezultat" }, { h: "Adrese", cls: "num" }, { h: "Coduri HTTP", cls: "wrap" }], [
        { k: "dead", l: "pagina nu mai există (404/410)", n: l.dead },
        { k: "error", l: "eroare la server (alt cod 4xx sau 5xx)", n: l.error || 0 },
        { k: "unreachable", l: "fără răspuns (expirare, DNS)", n: l.unreachable },
        { k: "ok", l: "au răspuns corect", n: l.sampled - l.dead - (l.error || 0) - l.unreachable },
      ].map((x) => ({ ...x, "0": x.l, "1": fmt(x.n), "2": codesFor(l.codes, x.k) })),
        (x) => (x.n && x.k !== "ok" ? { host, link: x.k } : null), (x) => host + " · " + x.l))}` : ""}
      ${format.length ? `<div class="section"><h2>Abateri de format</h2><span class="note">nu invalidează anunțul, dar indică ce e de corectat în scraper</span></div>${card(null, tabel(format))}` : ""}
      ${masurate.length ? `<div class="section"><h2>Indicatori măsurați</h2><span class="note">urmăriți în timp, necontabilizați ca neconformități</span></div>${card(null, tabel(masurate))}` : ""}`;
  },

  scrapere() {
    const s = state.run.summary;
    const byId = new Map(s.checks.map((c) => [c.id, c]));
    const MIN = 20;
    const toate = s.sources.filter((r) => r.affected > 0);
    const lista = (state.allHosts ? toate : toate.filter((r) => r.jobs >= MIN)).slice(0, 60);
    const rest = toate.length - lista.length;

    const fisa = (r) => {
      const probleme = Object.entries(r.byCheck)
        .map(([id, n]) => ({ ...byId.get(id), count: n }))
        .filter((c) => c.id && c.severity === "grav")
        .sort((x, y) => y.count - x.count).slice(0, 4);
      return `
        <div class="card">
          <div class="fisa-cap">
            <div>
              <a class="fisa-nume" href="#/sursa/${encodeURIComponent(r.host)}">${esc(r.host)}</a>
              <div class="fisa-sub">${fmt(r.jobs)} anunțuri · ${fmt(r.trusted)} valide · ${fmt(r.affected)} neconforme${r.window ? " · " + fmt(r.window) + " intrate recent" : ""}</div>
            </div>
            <div class="fisa-pct ${r.pct >= 50 ? "rau" : r.pct >= 20 ? "mediu" : ""}">${pct(r.pct)}</div>
          </div>
          ${probleme.length ? table([
            { h: "Neconformitate", f: (c) => esc(c.label) },
            { h: "De corectat", cls: "wrap", f: (c) => `<div class="fixnote">${esc(c.fix || "")}</div>` },
            { h: "Anunțuri", cls: "num", f: (c) => `${fmt(c.count)} <span class="muted">din ${fmt(r.jobs)}</span>` },
            { h: "Responsabil", f: (c) => badge(c.owner, OWNER[c.owner]) },
          ], probleme, (c) => ({ host: r.host, check: c.id }), (c) => r.host + " · " + c.label) : `<p class="note">nicio neconformitate majoră</p>`}
          <div class="foot"><a href="#/sursa/${encodeURIComponent(r.host)}">fișa completă a acestei surse →</a></div>
        </div>`;
    };

    return `
      <h1>Scrapere</h1>
      <p class="sub">Câte o fișă pentru fiecare site de pe care extragem anunțuri, cu neconformitățile lui și ce trebuie schimbat. Ordonate după numărul de anunțuri afectate.</p>
      <div class="chips">
        <span class="chip ${state.allHosts ? "" : "on"}" data-hosts="1">${state.allHosts ? "afișate toate cele " + toate.length + " surse cu probleme" : "numai sursele cu minimum " + MIN + " anunțuri" + (rest > 0 ? " (încă " + rest + " mai mici)" : "")}</span>
      </div>
      <div class="fise">${lista.map(fisa).join("")}</div>`;
  },

  surse() {
    const s = state.run.summary;
    const l = s.links;
    const MIN = 20;
    const big = s.sources.filter((r) => r.jobs >= MIN);
    const rows = state.allHosts ? s.sources : big;
    const toggle = s.sources.length > big.length
      ? `<span class="chip ${state.allHosts ? "on" : ""}" data-hosts="1">${state.allHosts ? `numai sursele cu minimum ${MIN} anunțuri` : `afișați toate cele ${s.sources.length} surse (încă ${s.sources.length - big.length} cu mai puțin de ${MIN} anunțuri)`}</span>`
      : "";
    const qcol = (id, label) => ({ h: label, cls: "num", f: (r) => r.q[id] ? `<span class="cell-link" data-jobs='${esc(JSON.stringify({ host: r.host, question: id }))}' data-title="${esc(r.host + " · " + label)}">${fmt(r.q[id])}</span>` : `<span class="muted">0</span>` });
    return `
      <h1>Surse</h1>
      <p class="sub">Distribuția anunțurilor pe surse și ponderea neconformităților pentru fiecare sursă. O pondere ridicată indică un scraper care necesită corecții. Selectați orice valoare pentru detalii.</p>
      <div class="chips">${toggle}</div>
      ${card(null, table([
        { h: "Sursă", f: (r) => `<a class="cell-link" href="#/sursa/${encodeURIComponent(r.host)}"><b>${esc(r.host)}</b></a>` },
        { h: "Anunțuri", cls: "num", f: (r) => fmt(r.jobs) },
        { h: "Valide", cls: "num", f: (r) => `<span class="cell-link" data-jobs='${esc(JSON.stringify({ host: r.host, trusted: "1" }))}' data-title="${esc(r.host + " · anunțuri valide")}">${fmt(r.trusted)}</span>` },
        { h: "Noi", cls: "num", f: (r) => r.fresh ? `<span class="cell-link" data-jobs='${esc(JSON.stringify({ host: r.host, nou: "1" }))}' data-title="${esc(r.host + " · anunțuri noi")}">${fmt(r.fresh)}</span>` : `<span class="muted">0</span>` },
        qcol("exista", "Indisponibile"), qcol("adevar", "Date incorecte"), qcol("format", "Format"),
        { h: "Neconforme", cls: "num", f: (r) => pct(r.pct) },
        { h: "", f: (r) => bar(r.pct, r.pct >= 50) },
        { h: "Adrese cu probleme", f: (r) => { if (!r.links) return `<span class="muted">–</span>`; const rele = r.links.dead + (r.links.error || 0); return rele ? `<span class="cell-link" data-jobs='${esc(JSON.stringify({ host: r.host, linkbad: "1" }))}' data-title="${esc(r.host + " · adrese cu probleme")}">${rele} din ${r.links.sampled}</span>` : `<span class="muted">0 din ${r.links.sampled}</span>`; } },
      ], rows, null, null).replace(/<tbody>/, "<tbody>").replace(/<tr>/g, "<tr>"), l ? `Coloana Neconforme cuprinde anunțurile care nu îndeplinesc cel puțin un criteriu de validitate. Adrese verificate: ${fmt(l.sampled)}, câte ${l.perHost} pentru fiecare sursă: ${fmt(l.dead)} nu mai există (404/410), ${fmt(l.error || 0)} întorc eroare de server, ${fmt(l.unreachable)} nu răspund. Verificare efectuată pe eșantion.` : "")}`;
  },
};

function afterRender(name) {
  const s = state.run.summary;
  if (name === "overview") {
    const w = s.incoming && s.incoming.window;
    if (w && w.byDay.length) {
      const zi = (d) => new Date(d).toLocaleDateString("ro-RO", { day: "numeric", month: "short" });
      chart($("#ch-intrari"), {
        tooltip: { ...tooltip, trigger: "axis", formatter: (ps) => {
          const d = w.byDay[ps[0].dataIndex];
          return `${zi(d.day)}<br><b>${fmt(d.jobs)}</b> intrate, dintre care <b>${fmt(d.affected)}</b> neconforme`;
        } },
        grid: { left: 8, right: 16, top: 12, bottom: 8, containLabel: true },
        xAxis: { type: "category", data: w.byDay.map((d) => zi(d.day)), ...axis },
        yAxis: { type: "value", ...axis },
        series: [
          { type: "bar", stack: "z", name: "în regulă", data: w.byDay.map((d) => d.jobs - d.affected),
            itemStyle: { color: "#2dd4bf" }, barMaxWidth: 34 },
          { type: "bar", stack: "z", name: "neconforme", data: w.byDay.map((d) => d.affected),
            itemStyle: { color: "#ef4444" }, barMaxWidth: 34 },
        ],
      }, (p) => { const d = w.byDay[p.dataIndex]; if (d) openJobs({ prima: d.day }, "Intrate pe " + zi(d.day)); });
    }
    hbar($("#ch-fresh"), s.overview.freshness, "value", "jobs", (d) => openJobs({ fresh: d.value }, "Vechime: " + d.value), "#38bdf8");
    donut($("#ch-wm"), s.overview.workmode, "value", "jobs", (d) => openJobs({ workmode: d.value }, "Mod de lucru: " + d.value));
  }
  if (name === "harta") {
    hbar($("#ch-loc"), s.map.topLocalities.slice(0, 15), "locality", "jobs", (d) => openJobs({ locality: d.locality, trusted: "1" }, d.locality));
    drawMap();
  }
  if (name === "companii") {
    const top = s.companies.top.slice(0, 25);
    hbar($("#ch-co"), top.map((r) => ({ ...r, label: r.name })), "label", "jobs", (d) => openJobs({ company: d.cif, trusted: "1" }, d.name));
    donut($("#ch-size"), s.companies.sizeBuckets, "value", "jobs", null);
  }
}

async function drawMap() {
  const s = state.run.summary;
  if (!state.geo) {
    state.geo = await (await fetch("vendor/romania-judete.geojson?v=" + encodeURIComponent(state.run.summary.runAt || "1"))).json();
    echarts.registerMap("ro", state.geo);
  }
  const el = $("#ch-map");
  if (!el) return;
  const byNorm = new Map(s.map.counties.map((c) => [norm(c.county), c]));
  const data = state.geo.features.map((f) => {
    const c = byNorm.get(norm(f.properties.name));
    return { name: f.properties.name, value: c ? c.jobs : 0, county: c ? c.county : f.properties.name };
  });
  const max = Math.max(1, ...data.map((d) => d.value));
  // log scale for the colour: București alone has a third of the index and would wash out every other county
  const lg = (v) => Math.log10(1 + v);
  chart(el, {
    tooltip: { ...tooltip, formatter: (p) => { const d = data.find((x) => x.name === p.name); return `<b>${esc(d ? d.county : p.name)}</b><br>${fmt(d ? d.value : 0)} anunțuri`; } },
    visualMap: { type: "continuous", min: 0, max: lg(max), left: 24, bottom: 24, orient: "horizontal", itemWidth: 12, itemHeight: 160,
      text: [fmt(max), "0"], textStyle: { color: "#8b98a8", fontSize: 11 }, calculable: false, dimension: 0,
      // dark = many jobs, pale = few
      inRange: { color: ["#e3f7f3", "#9adcd0", "#4bb5a6", "#23796d", "#0d4640"] } },
    series: [{ type: "map", map: "ro", roam: false, nameProperty: "name", selectedMode: false,
      layoutCenter: ["50%", "50%"], layoutSize: "96%",
      data: data.map((d) => ({ name: d.name, value: [lg(d.value), d.value] })),
      itemStyle: { borderColor: "rgba(255,255,255,.22)", borderWidth: 1 },
      emphasis: { label: { show: true, color: "#fff", fontWeight: 600, fontSize: 12, textBorderColor: "#0f1419", textBorderWidth: 3, formatter: (p) => p.name },
        itemStyle: { areaColor: "#fbbf24", borderColor: "#fff" } },
      label: { show: false } }],
  }, (p) => { const d = data.find((x) => x.name === p.name); if (d && d.value) openJobs({ county: d.county, trusted: "1" }, "Județul " + d.county); });
}

// ---- drawer ---------------------------------------------------------------------------
const drawer = { filter: null, title: "", page: 1 };
async function openJobs(filter, title, page) {
  drawer.filter = filter; drawer.title = title || "Anunțuri"; drawer.page = page || 1;
  $("#drawer").hidden = false; $("#scrim").hidden = false;
  $("#drawer-title").textContent = drawer.title;
  $("#drawer-sub").textContent = "se încarcă…";
  $("#drawer-body").innerHTML = "";
  $("#drawer-foot").innerHTML = "";
  const q = new URLSearchParams(Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined && v !== null)));
  q.set("page", String(drawer.page)); q.set("size", "50");
  const res = await fetch("/api/jobs?" + q.toString());
  const j = await res.json();
  if (!res.ok) {
    $("#drawer-sub").textContent = "";
    $("#drawer-body").innerHTML = `<div class="empty">${esc(j.error || "eroare")}</div>`;
    return;
  }
  const checks = new Map(state.run.summary.checks.map((c) => [c.id, c]));
  $("#drawer-sub").textContent = `${fmt(j.total)} anunțuri · pagina ${j.page} din ${Math.max(1, j.pages)}`;
  $("#drawer-body").innerHTML = j.items.map((it) => `
    <div class="job">
      <div class="t"><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title || "(fără titlu)")}</a></div>
      <div class="m">
        <span>${esc(it.company || "(fără companie)")}</span>
        ${it.cif ? `<span>CIF <a href="https://peviitor.ro/#/company/${esc(String(it.cif).padStart(8, "0"))}" target="_blank" rel="noopener">${esc(it.cif)}</a></span>` : ""}
        <span>${esc(it.location.join(", ") || "(locație necompletată)")}${it.loc && it.loc.kind === "fixed" ? ` → ${esc(it.loc.value)}${it.loc.county ? ", " + esc(it.loc.county) : ""}` : ""}</span>
        <span>${it.date ? new Date(it.date).toLocaleDateString("ro-RO") : "fără dată"}</span>
        <span>${esc(it.status)}</span>
        ${it.isNew ? `<span class="badge ok">nou</span>` : it.daysHere != null ? `<span class="muted">la noi de ${it.daysHere === 0 ? "azi" : it.daysHere + (it.daysHere === 1 ? " zi" : " zile")}</span>` : ""}
        ${it.coStatus && it.coStatus !== "activ" ? `<span>status ANAF: ${esc(it.coStatus)}${it.coChecked ? ", verificat la " + esc(it.coChecked) : ""}</span>` : ""}
        <span class="muted">${esc(it.host)}</span>
        ${it.link && it.link !== "ok" ? `<span class="badge grav">${it.linkCode ? "HTTP " + it.linkCode : esc(it.linkReason || "fără răspuns")}</span>` : ""}
      </div>
      <div class="i">${(() => {
        const grav = it.issues.filter((id) => checks.has(id) && checks.get(id).severity === "grav");
        const fmtIssues = it.issues.filter((id) => checks.has(id) && checks.get(id).severity === "minor");
        const head = grav.length
          ? grav.map((id) => `<span class="badge grav" title="${esc(checks.get(id).why)}">${esc(checks.get(id).label)}</span>`).join("")
          : `<span class="badge ok">valid</span>`;
        const tail = fmtIssues.length
          ? `<span class="fmt" title="Abatere de la contract, fără efect vizibil pentru utilizator">abateri de format: ${fmtIssues.map((id) => esc(checks.get(id).label.toLowerCase())).join(", ")}</span>`
          : "";
        return head + tail;
      })()}</div>
    </div>`).join("") || `<div class="empty">niciun anunț</div>`;
  $("#drawer-foot").innerHTML = `
    <button class="btn" id="pg-prev" ${j.page <= 1 ? "disabled" : ""}>← anterioara</button>
    <span>${fmt((j.page - 1) * j.size + 1)}–${fmt(Math.min(j.total, j.page * j.size))} din ${fmt(j.total)}</span>
    <button class="btn" id="pg-next" ${j.page >= j.pages ? "disabled" : ""}>următoarea →</button>`;
  $("#pg-prev").onclick = () => openJobs(drawer.filter, drawer.title, drawer.page - 1);
  $("#pg-next").onclick = () => openJobs(drawer.filter, drawer.title, drawer.page + 1);
}
function closeDrawer() { $("#drawer").hidden = true; $("#scrim").hidden = true; }
$("#drawer-close").onclick = closeDrawer;
$("#scrim").onclick = closeDrawer;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

// one delegated handler: anything with data-jobs opens the drawer
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-hosts]")) { state.allHosts = !state.allHosts; route(); return; }
  const el = e.target.closest("[data-jobs]");
  if (!el) return;
  if (e.target.closest("a[href]") && !el.matches("a")) return;   // a real link inside a clickable row keeps working
  e.preventDefault();
  openJobs(JSON.parse(el.dataset.jobs), el.dataset.title || "Anunțuri");
});

// ---- router --------------------------------------------------------------------------------
function route() {
  const h = location.hash;
  let name;
  if (h.startsWith("#/sursa/")) { state.host = decodeURIComponent(h.slice("#/sursa/".length)); name = "sursa"; }
  else name = { "": "overview", "#/": "overview", "#/probleme": "probleme", "#/format": "format", "#/scrapere": "scrapere", "#/harta": "harta", "#/companii": "companii", "#/surse": "surse" }[h] || "overview";
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === name || (name === "sursa" && a.dataset.nav === "scrapere")));
  disposeCharts();
  const el = $("#screen");
  if (!state.run || !state.run.summary) {
    el.innerHTML = `<h1>BAROMETRU</h1><p class="sub">${state.run && state.run.running ? "Prima analiză este în curs. Pagina se va actualiza automat la finalizare." : "Nu există nicio analiză."}</p>`;
    return;
  }
  el.innerHTML = screens[name]();
  afterRender(name);
}
window.addEventListener("hashchange", route);
loadRun();
