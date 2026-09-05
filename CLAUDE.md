# BAROMETRU

Data-quality dashboard for **peviitor.ro**, the open-source Romanian job search
engine. It reads the production Solr index and reports what is wrong with the
data. Live at <https://barometru-peviitor.onrender.com>.

## The one rule

**The app finds problems. It never fixes them.**

Nothing here normalizes, corrects, deduplicates or repairs anything. Writes to
Solr are refused at the client level in `lib/solr.js` — `update`,
`deleteByQuery`, `commit` and `addField` all throw. Derived data goes to
`cache/`, never back into the index.

If a change would make the app *repair* rather than *report*, it is out of
scope, however useful it looks.

## Two more invariants

**Only real production jobs.** No fixtures, no samples, no synthetic rows. Every
number on screen came from the live index.

**Every number opens.** A count you cannot click into is a count nobody can act
on. Charts, table rows, donut slices, map counties, stacked-bar segments — all
of them drill through to `GET /api/jobs` and show the actual jobs.

---

## Architecture

### The rule registry is the spine — `lib/rules.js`

A rule *is* a query. Its count is `COUNT(*)`; its rows are the same query, paged.
There are **25 rules** in five groups: Locații, Companii, Titluri, Câmpuri goale,
Abateri de la schemă.

Two tiers:

| tier | how it counts | how it pages |
|---|---|---|
| `solr` | a query against the index | the same query |
| `scan` | a JS predicate over one full pass | the materialized url list in `cache/rules.json` |

There used to be a third tier, `judge`, where a model adjudicated a flagged set.
It was removed: on a restarted container the verdict cache started empty and the
rule reported "nemăsurat" forever. One deterministic rule beats a rule that is
sometimes there.

The 12 rules in "Abateri de la schemă" come from the **peviitor_core** Job/Company
contract. That contract is authoritative — validate against it, never change it.

### The daily analysis — `server/pipeline.js`

Six steps, run as a scheduled job:

```
[1/6] classify    locations against the SIRUTA registry
[2/6] materialize evaluate every deterministic rule
[3/6] cor         match titles to official occupations, twice, model in between
[4/6] sources     group defects by scraper, ask the model to diagnose
[5/6] summary     the bulletin on the front page
[6/6] report      the long analysis behind /raport
```

Then it writes the snapshot (below).

**Nobody presses a button.** `startSchedule()` runs it once at boot, then checks
hourly and does nothing unless the cache is more than 22 hours old. The hourly
tick exists because a host that sleeps the container never reaches a timer set
for tomorrow. There is no "re-run" button in the UI and no account — see
*Access* below.

### Snapshot — `lib/snapshot.js`

The full analysis keeps the id of every job behind every rule, so it weighs
~300 MB and lives only in `cache/`, which does not survive a restart. Without
help, the first visitor after a redeploy meets a screen of dashes.

The snapshot is the small durable copy: counts without rows, the COR table, the
per-source table, the county tally, the bulletin, the report, **and the model's
verdicts**. ~400 KB. A copy is committed to `seed/snapshot.json` and ships with
the build, so a container that has never run the analysis opens with real
numbers and an honest date on them.

`restore()` runs at startup and writes back only the files that are missing —
`cor_ai.json`, `loc_ai.json`. Those are the only things in `cache/` that cost
money; without this, every redeploy re-bought a few hundred adjudicated titles.

Regenerate the committed seed after a good local run:

```bash
node tools/seed.js
```

### COR matching — `lib/cor.js`, `lib/cor_ai.js`

Titles are matched against the official Romanian occupation register (4.422
entries in `lib/cor.json`). Deterministic tiers: exact, synonym, phrase, segment,
prefix, subset, alias, singular, fuzzy. That reaches ~63%.

The residue is two honest failures, and the model handles both:

- **ambiguous** — the title opens several occupations ("Consilier vânzări" opens
  both the insurance one and the jewellery one)
- **unmatched** — the register has no wording for it at all ("Consultant
  vânzări" where COR says "agent de vânzări"), or the title is in English

Candidates always come *from* COR, so the model **chooses** a code; it cannot
invent one. A title it is unsure about stays unmatched rather than force-fitted.
Verdicts are cached by title + prompt hash.

The matcher runs a second time afterwards so the verdicts are actually applied.
That moved coverage from 63,0% to **65,3%** and the jobs placed by the model from
205 to 2.161. Both numbers climb a little each day as more of the residue gets
adjudicated; read the current ones from `cache/cor.json`.

`lib/cor_ai.js` was written long before anything called it. If a capability
looks missing here, check whether it exists and is simply unwired.

### AI — `lib/llm.js`

Three providers in round-robin: Claude, Gemini, Groq. `askBalanced()` spreads
load; `ask({ order })` prefers one. A daily call budget (`LLM_DAILY_CALLS`,
default 400) stops a runaway loop — it is not rationing, the pass is scheduled.

`assertClean()` rejects a generation containing characters from another script.
A bulletin once came back with a Han character wedged mid-word and was cached
because nothing looked at the text first.

**Prompts are written with diacritics.** A prompt that says "în română cu
diacritice" while itself having none teaches the model the opposite; every
bulletin came back flat until this was fixed.

### Frontend — `public/`

- `app.js` — views, the drawer, the sortable/paginated `dataTable()` helper
- `charts.js` — every chart, on ECharts
- `vendor/echarts.min.js`, `vendor/romania-judete.geojson`

**Why ECharts** and not Plotly or sigma.js: sigma draws node-and-edge graphs and
we have no network data; Plotly is 1,1 MB of scientific tooling with a zoom
toolbar that fights the design. ECharts renders to canvas and hands back the data
item that was clicked, which is what makes every mark drillable.

Charts: location donut, top-rules bars, source stacked bars, county map,
occupation treemap, top-N bars with a scroll window.

The **county map** uses no tile server and no geocoder — not Nominatim, not
Photon, not Leaflet. SIRUTA already says which county every locality is in
(`data/locality_county.json`, 10.222 names, 216 KB) and the outlines are a
GeoJSON we serve ourselves. It works offline and leaks no query about what this
dashboard is looking at.

The theme is dark, fixed. There is no toggle.

### The printable report — `/raport`, `server/report.js`, `lib/report.js`

A page that knows how to print itself; the browser writes the PDF. No PDF
library on the server and no headless Chromium in the image. The model writes
four sections; every table under them is measured.

---

## Access

There is no login. There used to be one, guarding a "re-run the analysis"
button — and when the analysis became a scheduled job, the password guarded a
button that no longer existed, while asking a reader of a public status page to
sign in bought nothing.

What replaced it is stricter: **the endpoints that cost money are not reachable
over the network at all.** `INTERNAL` in `server/index.js` lists them; the
scheduler calls them in-process, and a request from outside gets 403 whoever it
is. A forwarding header alone disqualifies a request, because a proxied request
can still arrive on the loopback interface.

Reading is open to everyone. Writes to Solr are refused regardless.

---

## Running it

```bash
node server/index.js
```

Port 7777 by default (`PORT` overrides). It starts the schedule immediately.

Environment (`.env` locally, dashboard on the host):

| variable | what |
|---|---|
| `SOLR_BASE`, `SOLR_USER`, `SOLR_PASS` | production index, read-only |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` | Claude |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Gemini |
| `GROQ_API_KEY`, `GROQ_MODEL` | Groq |
| `LLM_DAILY_CALLS` | call budget, default 400 |
| `PLAYWRIGHT_ENABLED` | leave `0`; the free plan has neither Chromium nor the RAM |

**No secret belongs in a file in this repo.** They were hardcoded once and
removed before the first commit.

### Deployment

Render, from `main`. `render.yaml` is a blueprint and is **ignored** if the
service was created by hand in the dashboard — which it was. So the health check
path and the environment variables have to be set there, not here.

`healthCheckPath` must be `/api/health`. It pointed at `/login` once; when the
login route was deleted, every deploy built, passed, failed the health check, and
Render silently kept the old version. Three pushes appeared to do nothing.

---

## Things that bit, so they do not bite again

**Facet caps become silent lies.** `/api/top` capped at 100, which turned "all
companies" into "the hundred biggest" without saying so. There are 10.679.

**A capped collector plus a sort is a sorted prefix, not a top-N.** The unmatched
title list stopped collecting at 400 entries and *then* sorted by job count. The
biggest unmatched title on screen had 17 jobs; the real one has 687
("Shuffler"). If you cap, cap after sorting.

**Chunk requests by length, not by count.** Forty urls was fine until a scraper
turned up whose links carry a paragraph of tracking parameters each; forty of
those built a query string the proxy refused with 414.

**A purely negative Lucene clause dies in parentheses.** `-tags:*` next to
another clause returns zero. It needs `*:*` in front.

**The reason column must be about the rule you opened.** It used to run a fixed
ladder of checks and print the first that fired — so opening "HTML in the company
name" could report "relative path, no domain": a true sentence about a different
problem, which reads as a broken dashboard. `WHY` in `app.js` is keyed by rule id
and there is a check that every rule has an entry.

**`title` is `text_general`, so a quoted query is a phrase, not an equality.**
Asking for "Consultant vanzari" also returns "Consultant vanzari auto". The table
counts exact titles, so the drawer filters to exact after the phrase query —
otherwise the two disagree.

**`location` is `text_general` too**, by design in peviitor's own schema. Exact
locality filtering goes through the sidecar in `cache/locations.json`, not
through Solr.

**CIF needs zero-padding for their company route.** `peviitor.ro/#/company/08119423`,
not `.../8119423`. `cifKey()` strips leading zeros for *comparison*; the link
pads them back.

**`.dockerignore` can hide a file you need.** `siruta_localities.json` is
excluded, so on a host that builds an image the county map came out empty while
every other location number was right. That reads as a broken map and was a
missing file. Hence `data/locality_county.json`.

**Do not call `begin()` from inside the pipeline.** It replaces the module's
`current` job and destroys the pipeline's own status halfway through. `runCor()`
exists precisely to separate the matching from the job bookkeeping.

**Yield during long CPU loops.** The COR pass froze the server until it started
`await new Promise(r => setImmediate(r))` every 500 titles.

**Do not invent data.** A CIF was once made up while testing. Everything shown
must trace back to the index or to a registry file in this repo.

---

## Where the damage is

Defects concentrate by scraper, which is the single most useful thing this app
says. Three sources produce most of it:

| source | jobs | affected |
|---|---|---|
| jobviewtrack.com | 20.227 | 95,2% |
| mediere.anofm.ro | 11.540 | 97,8% |
| iajob.ro | 11.471 | 80,6% |

A dark column in the per-source view means every scraper makes the same mistake
and the fault is probably ours. A single long bar means one feed is broken and
fixing it cleans thousands of rows at once.

---

## Unfinished

`lib/discover.js` — the model finding problems the 25 rules do not encode. It is
written and has never returned anything but empty text. Nothing calls it.
