# ANALIZA BACKEND — Doctor SOLR

Audit executat pe index-ul viu: **58.684 joburi** (core `job`, uniqueKey=`url`), **16.117 companii** (core `company`, uniqueKey=`id`=CIF).
Fiecare cifră din acest document provine dintr-o interogare rulată efectiv pe Solr la data auditului. Nimic nu este estimat.

---

## PRINCIPIUL CARE GUVERNEAZĂ TOATĂ RESTRUCTURAREA

> „când arăți chestii în neregulă, dă fetch și la joburile alea"

Aplicația este o **vedere de ansamblu peste toată baza de date**, iar **fiecare număr afișat trebuie să fie apăsabil** și să ducă la documentele reale din spatele lui — url, titlu, companie, CIF, locație, dată — nu doar la un contor.

Consecință de arhitectură: **un singur endpoint generic de drill-down**, `GET /api/jobs?issue=<rule-id>`, și un **registru de reguli** în care fiecare regulă știe să-și producă mulțimea de joburi. Nu o duzină de endpoint-uri ad-hoc. Secțiunea „ARHITECTURA DRILL-DOWN" rezolvă explicit partea grea: cum stau în spatele aceleiași interfețe atât regulile care sunt pur interogări Solr, cât și cele care cer clasificare în JS.

---

# PARTEA I — CELE 6 DEFECTE

## DEFECT 1 — ASISTENTUL ESTE MORT

### Cauza rădăcină: `server/index.js:87` vs `server/api.js:787`

Nu este o problemă de gateway, nu este `.env`, nu este forma cererii din frontend. Este o **nepotrivire de convenție de apel** între router și handler.

Routerul apelează **toate** handler-ele cu un singur obiect-anvelopă:

```js
// server/index.js:87
const out = await handler({ query, body, req });
```

Dar `postChat` este scris ca și cum ar primi direct body-ul:

```js
// server/api.js:787-792
async function postChat(body) {              // <-- primește {query, body, req}
  const { messages, text } = body;           // <-- body.text === undefined
  if (!text || typeof text !== "string") {
    return { status: 400, body: { error: "expected { messages: [...], text: '...' } - 'text' is required" } };
  }
```

`postChat` primește `{query, body, req}`, deci `body.text` este `undefined`, deci validația proprie respinge cererea cu 400.

**Eroarea este generată local, de validarea noastră** (`server/api.js:791`), **nu de gateway.** Gateway-ul nu este contactat niciodată.

Frontend-ul este **corect** — `public/app.js:927` trimite deja forma bună:
```js
const r = await apiPost("/api/chat", { messages: chatHistory, text }, 60000);
```

`.env` este **corect** și încărcat corect. `server/assistant.js:15` folosește `path.join(__dirname, "..", ".env")` — nu cade în capcana CWD.

### Același bug lovește și `postNormalize`

`server/api.js:805` — `async function postNormalize(body)` cu `body.confirm`. Verificat live:
```
POST /api/normalize {"confirm":true}
-> {"error":"refusing to write: POST body must include { \"confirm\": true }"}
```
**Butonul de normalizare nu a putut funcționa niciodată.** Handler-ele din `server/actions.js` (`postNormalizeAction({ body })`) folosesc destructurarea corectă — de aceea acțiunile din bara de sus merg, iar `/api/normalize` nu.

### Al treilea handler afectat: `getLinks`

`server/api.js:544` — `async function getLinks(query)` citește `query.limit`, dar primește `{query, body, req}`, deci `query.limit` e `undefined` și `limit` cade mereu pe default-ul 50. `?limit=200` este ignorat în tăcere.

### Fix exact

```js
// server/api.js:787
async function postChat({ body }) {

// server/api.js:805
async function postNormalize({ body }) {

// server/api.js:544
async function getLinks({ query }) {
```

Trei semnături. Nimic altceva.

### Verificat efectiv

Apel direct pe handler cu forma corectă:
```
postChat({messages:[], text:"Cate joburi sunt in index si cate au salariu?"})
-> status 200
-> "Total joburi în index: 58.684 | Joburi cu salariu: 0"
-> toolsUsed: ["solr_count","solr_count"]
```

Și end-to-end peste HTTP (server temporar pe :7799 care aplică doar fix-ul de o linie, fără modificări în repo), cu **exact payload-ul pe care îl trimite `public/app.js`**:
```
POST / {"messages":[],"text":"Cate locatii junk sunt in index?"}
-> 200 {"answer":"În index sunt 0 locații junk ...","toolsUsed":["data_quality_report"]}
```

Gateway-ul `https://aiprimetech.io/v1/messages`, modelul `claude-opus-5`, tool-loop-ul și bugetul funcționează perfect. **Un singur caracter de sintaxă a ținut tab-ul mort.**

> Notă importantă: răspunsul asistentului de mai sus („0 locații junk") este **greșit din cauza Defectului 2** — `data_quality_report` citește câmpurile `junk`/`verified` din Solr, care nu sunt populate. Asistentul raportează corect ce-i dau tool-urile; tool-urile mint. Se repară odată cu Defectul 2.

---

## DEFECT 2 — ACOPERIRE CÂMPURI = TOT ZERO

Sunt **trei bug-uri distincte** aici, nu unul. Cache-ul nu este vinovat de niciunul.

### Adevărul din Solr (interogat direct)

| Câmp | Completate | % |
|---|---:|---:|
| url | 58.684 | 100,00% |
| title | 58.684 | 100,00% |
| company | 58.684 | 100,00% |
| cif | 58.684 | 100,00% |
| location | 58.684 | 100,00% |
| date | 58.684 | 100,00% |
| status | 58.684 | 100,00% |
| tags | 58.448 | 99,60% |
| workmode | 58.443 | 99,59% |
| **salary** | **0** | **0,00%** |

Backend-ul calculează asta **corect**. `GET /api/overview` returnează live:
```json
"fieldCoverage": { "url": {"filled":58684,"pct":100}, ..., "salary": {"filled":0,"pct":0} }
```

### Bug 2a — frontend-ul citește o structură imbricată ca pe un număr

`public/app.js:346-360`. Panoul citește `/api/fields` (nu `fieldCoverage` din `/api/overview`), care returnează `{fields: {url: {filled, filledPct, valid, validPct, problems}, ...}}`.

`asArray()` (app.js:81) transformă obiectul în `[{key:"url", value:{filled:...}}, ...]`. Apoi:

```js
const filled = pick(f, ["filled", "count", "value"], null);   // f.filled undefined -> ia f.value = OBIECT
return { ..., value: pct !== null ? Number(pct) : Number(filled) || 0 };
//                                                 Number({...}) = NaN  ->  NaN || 0  ->  0
```

`f.pct` nu există (cheia reală e `filledPct`), deci se merge pe ramura `filled`; `f.filled` nu există la nivelul anvelopei `{key,value}`, deci `pick` returnează `f.value`, care e un obiect; `Number(obiect)` = `NaN`; `NaN || 0` = **0**.

Eticheta iese corectă (`f.key`), valoarea iese 0 — **exact simptomul din screenshot: nume corecte, toate barele pe zero.**

**Fix** (`public/app.js`, în `loadOverview`, maparea peste câmpuri):
```js
const items = Object.entries(fields).map(([name, v]) => ({
  label: name,
  value: Number(v.filledPct ?? v.pct ?? 0),
  filled: Number(v.filled ?? 0),
  isPct: true,
}));
```

### Bug 2b — donut-ul 0/0/0/0: se interoghează câmpuri care nu au fost scrise niciodată

`lib/analytics.js:238-245`:
```js
solr.count("verified:true"),   // 0
solr.count("verified:false"),  // 0
solr.count("international:true"), // 0
solr.count("junk:true"),          // 0
```

Verificat în Solr:
```
verified:true = 0 | verified:false = 0 | verified:* = 0 | -verified:* = 58.684
international:true = 0 | junk:true = 0
```

Câmpurile `verified`, `international`, `junk` **există în schema** (tip `boolean`) dar **nu sunt populate pe niciun document**, pentru că normalizarea nu a rulat niciodată (și nici nu putea — vezi Defectul 1, `postNormalize` era rupt).

`unverified` este calculat ca `verified:false`, ceea ce e greșit conceptual: un document nescris nu e „false", e **absent**.

**Fix** (`lib/analytics.js:242`):
```js
solr.count("-verified:*"),   // documente neatinse de normalizare = 58.684
```
Afișarea corectă azi este **„58.684 neverificate (100%)"**, nu patru zerouri.

În plus, panoul trebuie să distingă două lucruri diferite:
- **starea scrisă în index** (`verified`/`international`/`junk` — azi: 0/0/0, nescrise)
- **clasificarea calculată live** de `lib/locations.js` (azi: 55.864 corectabile / 200 internaționale / 2.212 junk)

A doua este singura care are conținut acum și este cea pe care o vrea utilizatorul.

### Bug 2c — „joburi complete = 0" este corect, dar înșelător

`server/api.js:539` construiește `url:* AND title:* AND ... AND salary:* AND ...`. Cum `salary:*` = 0 documente, intersecția e **matematic obligatoriu 0**. Nu e bug de query — e o definiție proastă.

Un singur câmp care lipsește 100% face metrica identic nulă și fără informație.

**Fix:** se calculează completitudinea pe **câmpurile obligatorii** (excluzând `salary`, care e absent structural), și se afișează separat:
- complete pe câmpuri obligatorii (url, title, company, cif, location, date, status, tags, workmode) → **58.336 joburi (99,41%)**, măsurat direct; doar 348 de joburi au vreun câmp obligatoriu lipsă
- `salary` raportat separat, ca gaură cunoscută de 100%

> Capcană Solr de evitat la implementare: `-tags:* OR -workmode:*` returnează **129**, un rezultat fals — Solr nu tratează corect clauzele pur negative într-un `OR`. Numărul corect de joburi incomplete (348) se obține prin scădere din interogarea conjunctivă pozitivă, nu prin `OR` de negații.

---

## DEFECT 3 — TAB-UL LOCAȚII NU LISTEAZĂ LOCAȚIILE PROASTE

### Cauza rădăcină: nepotrivire de nume de chei, `public/app.js:298`

Backend-ul **produce deja** listele proaste. `GET /api/locations` returnează live:
```json
"bad": { "foreign": [...30], "junk": [...23], "fake": [...10], "unknown": [] }
```

Frontend-ul le caută sub alte nume, la alt nivel de imbricare:
```js
// public/app.js:298
const strange = asArray(pick(d, ["strangeLocations","fakeLocations","junkExamples","junkLocations"], []));
```

Niciunul dintre cele patru nume nu există în răspuns, iar cheile reale sunt imbricate sub `bad.*`. `strange` rămâne `[]`, iar blocul `if (strange.length)` (app.js:315) nu se randează **niciodată**. De asta tab-ul arată doar normalizările propuse și nimic altceva.

### Adevărul din Solr — clasificarea tuturor celor 4.937 valori distincte de locație

Rulat cu `lib/locations.js classify()` peste un scan complet al index-ului:

| Categorie | Valori distincte | Joburi | % din index |
|---|---:|---:|---:|
| deja canonice (`fixed`, fără schimbare) | 17 | 463 | 0,79% |
| **corectabile** (`fixed`, se rescrie) | 4.739 | 55.864 | 95,19% |
| **junk** (nu e un loc) | 33 | 2.212 | 3,77% |
| **internaționale** | 148 | 200 | 0,34% |
| goale | 0 | 0 | 0,00% |

Din cele 33 junk, **10 conțin cifre** (10 joburi) — adrese de stradă scăpate în câmpul de localitate.

### JUNK — toate cele care contează (valori reale, cu joburi reale)

| Joburi | Valoare | Motiv |
|---:|---|---|
| 1.033 | `Romania` | not-a-place (țara, nu localitatea) |
| 743 | `Remote, Romania` | not-a-place |
| 207 | `România` | not-a-place (varianta cu diacritice) |
| 150 | `all, Romania` | not-a-place |
| 22 | `Strainatate, Romania` | not-a-place |
| 12 | `All, Romania` | not-a-place |
| 10 | `RO-BUH-BUCHARESTSEIMAFOF, Romania` | not-a-place (cod intern) |
| 6 | `Nespecificat, Romania` | not-a-place |
| 4 | `Remote -, Romania` | not-a-place |
| 2 | `Medior, Romania` | not-a-place (nivel de senioritate!) |
| 1 | `contact@flarom.ro, Romania` | email în câmpul de locație |
| 1 | `VAS DE CROAZIERA, Romania` | not-a-place |
| 1 | `3 Locations, Romania` / `2 Locations, Romania` | placeholder Workday |
| 1 | `Str. Sf. Lazar, nr.6, Romania` | adresă de stradă |

**Concentrare: 2.145 din 2.212 joburi junk (97%) provin din doar 4 valori** — `Romania`, `Remote, Romania`, `România`, `all, Romania`. Se rezolvă cu 4 reguli de mapare, nu cu 33.

Joburi reale din spate (drill-down `issue=loc_junk`):
```
"Asistenta manager" @ DOX FILM SRL — loc="Romania" — https://8ore.ro/locuri-de-munca/asistenta-manager
"Muncitori constructii" @ OLIVER CONSTRUCTION LOGISTICS S.R.L. — loc="Romania"
"Key Account Manager HoReCa" @ TODAY WORKFORCE S.R.L. — loc="Romania"
"Curieri Glovo Wolt Bolt" @ DANI GLOVO S.R.L. — loc="Romania"
```

### INTERNAȚIONALE — 148 valori distincte, 200 joburi

Tiparul dominant: scraper-ul **lipește „, Romania" pe orice locație**, inclusiv pe orașe străine. De aici `Olanda, Romania`, `Padova, Romania`, `Freiburg, Romania`.

| Joburi | Valoare | Motiv |
|---:|---|---|
| 14 | `Olanda, Romania` | known-foreign |
| 11 | `Austria, Romania` | known-foreign |
| 10 | `Germania, Romania` | known-foreign |
| 6 | `Padova, Romania` | known-foreign |
| 4 | `Chennai ITEC/KBS, Romania` | unknown-place |
| 3 | `Venezia, Romania` | known-foreign |
| 3 | `Praha 5, Romania` | unknown-place |
| 2 | `Brussels, Romania` / `Bruxelles, Romania` / `Amsterdam, Romania` | known-foreign |
| 2 | `Adelaide, Romania` / `Lombard IL, Romania` | unknown-place |
| 1 | `Barcelona`, `Bratislava`, `Luxembourg City`, `Suedia`, `Liege`, `Acapulco`, `Cordoba` (toate „, Romania") | known-foreign |

Joburi reale (drill-down `issue=loc_international`):
```
"Angajam in Germania; Dulgheri-Fierari-Zidari" @ BLYTHSWOOD BANAT SRL — loc="Freiburg, Romania"
"Angajam in Italia : Rigipsari ; Gletari interioare" @ EMME MARIN CONSULTI S.R.L. — loc="Venezia, Romania"
"Angajam : Fierari ; Dulgheri : Muncitori in constructii" @ ASCONTI VFT S.R.L. — loc="Germania, Romania"
```
Titlurile confirmă clasificarea: sunt **real** joburi în străinătate, marcate ca fiind în România.

Două surse domină: `8ore.ro` (recrutare pentru străinătate) și `kone.wd3.myworkdayjobs.com` (feed global Workday intrat integral în index-ul RO).

### NECLASIFICATE / de verificat

Nu există bucket „unmatched" separat: `classify()` returnează întotdeauna una din `fixed`/`international`/`junk`. Ce se apropie de „nesigur" sunt cele **17 valori deja canonice** (463 joburi) și cele marcate `how="unknown-place"` sau `how="unrecognised"` (≈40 valori). Acestea trebuie expuse ca bucket propriu, `loc_low_confidence`, pentru revizuire manuală — sunt cazurile în care clasificatorul a ghicit.

### Fix

Backend — se adaugă `examples[]` (joburi reale) la fiecare intrare din bucket și se elimină tăierea la 30:
```json
{ "value": "Remote, Romania", "count": 743, "how": "not-a-place",
  "issue": "loc_junk",
  "examples": [{ "url": "...", "title": "...", "company": "...", "location": "..." }] }
```
Frontend — se citește `d.bad.junk` / `d.bad.foreign` / `d.bad.fake`, nu numele inexistente; fiecare rând devine apăsabil către `/api/jobs?issue=loc_junk&value=<valoare>`.

---

## DEFECT 4 — LOGICA ȘI GRAFICELE DE SALARIU

### Adevărul, re-verificat pe index-ul curent de 58.684 documente

```
salary:*   =  0
-salary:*  =  58.684
facet pe salary  ->  0 valori
sample(salary:*) ->  0 documente
```

**Câmpul `salary` este gol pe 100,00% din index. Nu 99%. Zero documente, complet.**

Concluzia anterioară („~1%") era **prea optimistă**. Cifra reală a câmpului este **0,00%**.

Nu există nici câmp `description` de exploatat: schema `job` are exact `cif, company, date, expirationdate, international, junk, location, salary, source, status, tags, title, url, vdate, verified, workmode`. `source`, `vdate`, `expirationdate` sunt și ele **0 documente**.

### Singurul semnal de salariu care există: titlul

Regex de monedă peste toate cele 58.684 titluri:

| Măsurătoare | Valoare |
|---|---:|
| titluri cu o sumă de bani (`lib/analytics.js`, parser conștient de unități) | **530 (0,90%)** |
| titluri cu o sumă (regex mai strict, min. 3 cifre) | **432 (0,74%)** |
| sume RON | 395 |
| sume EUR | 135 |
| sume lunare RON utilizabile pentru medie | **298** |
| tarife orare/zilnice (excluse din medie, corect) | 99 |
| mediană (RON/lună) | 3.250 |
| medie | 3.402 |
| min / max | 35 / 16.000 |

Formatele reale găsite:
```
"OPERATOR PRODUCTIE - SLATINA - 3500 Lei"
"Operator productie- Venit 3200 Lei"
"Analist Incident Motor | 5.000 RON NET | Mioveni"
"Bonă pentru 1 copii de 1-3 ani, Calea Serban Voda, ..., începând cu 4200 lei/lună"
"Bonă pentru 1 copii de 1-3 ani, Calea Baciului, Part Time, începând cu 45 lei/oră"
```

**Avertisment de reprezentativitate, esențial:** din cele 25 de mostre extrase, **majoritatea covârșitoare sunt anunțuri „Bonă pentru N copii"** de la un singur agregator. Cele 530 de titluri cu salariu **nu sunt un eșantion aleator din piață** — sunt aproape în întregime îngrijire copii + câteva posturi de producție. Mediana de 3.250 RON este **mediana pentru bone în București**, nu pentru piața muncii din România.

### Ce este ONEST posibil

**DA — se poate face:**
1. **Contor de acoperire.** „530 din 58.684 joburi (0,90%) au vreo informație de salariu." Cea mai utilă cifră din tot tab-ul, pentru că spune adevărul.
2. **Distribuție pe monedă.** RON 395 / EUR 135. Bază reală, două categorii.
3. **Parsare în min/max/monedă/unitate.** Parser-ul din `lib/analytics.js` face deja asta corect și separă corect orar/zilnic de lunar. De păstrat.
4. **Listă drilabilă a celor 530.** Tabel cu titlu, companie, sumă parsată, monedă, unitate, url. **Aceasta este cea mai onestă „vizualizare de salariu" posibilă pe datele astea** — se arată exact ce se știe, pe fiecare rând.
5. **Un card de acoperire pe sursă**, care arată *care scraper* aduce vreodată salariu (răspuns: practic doar unul).

**NU — nu se poate face; a desena aceste grafice ar fi minciună:**
1. **Mediană pe județ.** 298 de sume lunare RON împrăștiate pe 41 de județe = câteva puncte per județ, dominate de un singur agregator. Nesemnificativ statistic.
2. **Mediană pe grupă ocupațională COR.** Și mai rău: 60,50% din titluri nu se potrivesc cu niciun cod COR, iar cele care au salariu sunt aproape toate aceeași ocupație.
3. **Histogramă de distribuție a salariilor.** Cele 7 bucket-uri actuale din `buildSalaryBuckets` (`server/api.js:184`) se umplu din 298 de valori nereprezentative. Graficul arată convingător și este fals.
4. **Orice tendință în timp.** Toate cele 58.684 de date sunt în 2026; nu există serie temporală.
5. **Acoperire pe companie.** Ar returna „0%" pentru 9.727 din 9.728 de companii.

### Recomandare, fără menajamente

Tab-ul „Salarizare" trebuie **degradat de la dashboard la raport de un singur ecran**:

> **Salariu: 0,00% din câmpul dedicat, 0,90% recuperat din titluri.**
> Nu se pot produce analize de salariu pe acest index. Cele 530 de joburi cu vreo sumă sunt listate mai jos și provin covârșitor de la un singur agregator (anunțuri de îngrijire copii), deci nu sunt reprezentative pentru piață. Media/mediana de mai jos descriu acele 530, nu România.

Și se elimină histograma. Un grafic care arată autoritar pe 298 de puncte părtinitoare face mai mult rău decât o propoziție cinstită.

Cauza reală de reparat nu e în dashboard, ci în **ingestie**: scraper-ele iau doar cardul de listare, nu pagina de descriere unde e trecut salariul.

---

## DEFECT 5 — LISTA DE LINKURI MOARTE ESTE INUTILIZABILĂ (rânduri „?")

### Cauza rădăcină: `public/app.js:824-833`

`GET /api/links` returnează `results` ca **obiect indexat după url**, nu ca array:
```json
"results": { "https://...": { "url","host","status","result","ms","checked" }, ... }
```

Frontend-ul:
```js
const dead = asArray(pick(d, ["dead","notFound","results"], []))
  .filter((x) => typeof x !== "object" || !("status" in x) || x.status === 404 || x.dead);
```

1. `asArray` pe un obiect produce `[{key:"https://...", value:{...}}]` — anvelope, nu rânduri.
2. Filtrul: `x` este `{key,value}`, deci `"status" in x` este **false**, deci `!("status" in x)` este **true** → **fiecare link trece filtrul, inclusiv toate cele OK.**
3. Randarea: `u.url` este `undefined` (adevărata cale e `u.value.url`) → se afișează `"?"`. `u.status` este `undefined` → se afișează literalul `"404"`.

Rezultat: o listă de `?` etichetate `404`, deși **niciun link nu e mort**. Exact simptomul raportat.

### Cât s-a verificat de fapt

Din `cache/links.json`:
```
linkuri verificate în total: 114   (64 la prima citire a auditului + 50 la un apel /api/links)
byResult: { ok: 114 }
dead: 0 | blocked: 0 | ratelimited: 0 | unreachable: 0
```
Gazde acoperite: `jobviewtrack.com` (24), `careers-page.com` (11), `tremend.com` (9), `bestjobs.eu` (6), `careers.evolution.com` (5), `mediere.anofm.ro`, `jobzz.ro`, `hipo.ro`, `hella.csod.com`, `prysmiangroup.wd3.myworkdayjobs.com`, `jobs.smartrecruiters.com`.

**114 din 58.684 de urluri verificate = 0,19% din index. Zero moarte.** Panoul afirma implicit un lucru fals pe o bază de aproape zero.

Bonus găsit: `getLinks` ignoră `?limit=` (Defectul 1), deci nu se putea verifica niciodată mai mult de 50 odată.

### Forma de rând necesară

`lib/links.js` nu știe decât urluri — nu are titlu/companie. Trebuie **îmbogățit din Solr** după verificare (un singur `url:(...)` batch, ≤1024 clauze):

```json
{
  "url": "https://...",
  "title": "Operator productie",
  "company": "GEORGIANA SRL",
  "location": "Bucuresti, Romania",
  "host": "jobviewtrack.com",
  "httpStatus": 404,
  "classification": "dead",
  "checkedAt": "2026-08-20",
  "responseMs": 1182
}
```

Plus, în antet, onestitatea acoperirii: `"checked": 114, "total": 58684, "coveragePct": 0.19`.

### Fix

1. `server/api.js:544` — `getLinks({ query })` (Defectul 1), ca `?limit=` să funcționeze.
2. `server/api.js:551` — se convertesc rezultatele în array **și** se îmbogățesc din Solr:
   ```js
   const rows = Object.values(results);
   const docs = await fetchByUrls(rows.map(r => r.url));   // un singur batch Solr
   const byUrl = new Map(docs.map(d => [d.url, d]));
   return { checked: rows.length, total, coveragePct: pct(rows.length, total),
            summary, byHost: summary.byHost,
            results: rows.map(r => ({ ...r, ...pickFields(byUrl.get(r.url)) })) };
   ```
3. `public/app.js:824` — se filtrează pe `r.classification === "dead"`, nu pe absența cheii, și se randează titlu + companie + status.
4. Când nu există niciun link mort, se afișează **„0 linkuri moarte din 114 verificate (0,19% din index)"** — nu un tabel gol de `?`.

---

## DEFECT 6 — AVERTISMENTE ȘI SFATURI SUPERFICIALE

### Ce implementează azi `lib/analytics.js warnings()` (linia ~530)

| Regulă | Cifra reală | Verdict |
|---|---:|---|
| `shoutingTitles` (TITLU CU MAJUSCULE) | **9.698 (16,53%)** | **Zgomot.** Utilizatorul are dreptate. |
| `weirdTitles` — too-short | 2 | irelevant ca volum, dar valid |
| `weirdTitles` — too-long (>120 car.) | 17 | marginal |
| `weirdTitles` — punctuation-heavy | 136 | marginal |
| `duplicateTitles` (doar titlu, nu titlu+companie) | 5.025 perechi | **prea slab** — vezi mai jos |
| `missingSalary` | 58.154 (99,10%) | corect, dar cifra reală a câmpului e 58.684 (100%) |
| `missingCif` | 0 | regulă moartă — CIF nu lipsește niciodată |
| `missingTags` | 236 | valid, volum mic |
| `adultOrEscortTitles` (în `server/api.js:373`) | **11** | **interogare greșită** — vezi mai jos |

**De ce „ALL CAPS" e zgomot:** 16,53% din index. O regulă care marchează unul din șase joburi nu e un avertisment, e o observație despre stilul agregatorilor. Trebuie **retrogradată la „cosmetic"**, nu ștearsă — dar niciodată deasupra unor probleme care rup funcționalitatea.

**Bug găsit în regula adult:** `ADULT_QUERY` din `server/api.js:373` caută `escort, erotic, onlyfans, striptease, strip, ...` dar **omite `videochat`** — termenul dominant în română. Verificat:
```
interogarea actuală              -> 11 joburi
aceeași interogare + videochat   -> 42 joburi
```
**Regula ratează 74% din cazurile reale.** Fix: se adaugă `videochat OR "video chat"` la `ADULT_QUERY`.

**Bug în regula de duplicate:** `duplicateTitles` grupează pe **titlu**, ignorând compania — de aceea „Asistent Medical Generalist" x555 apare ca un singur rând, deși pot fi companii diferite. Gruparea corectă pe **(titlu, companie)** dă **6.161 perechi / 18.490 rânduri redundante (31,51%)** — o problemă mult mai mare decât se raporta.

### Setul de reguli propus — fiecare cu volumul REAL măsurat

Toate cifrele de mai jos provin dintr-un scan complet al celor 58.684 de documente, cu `lib/locations.js`, `lib/cor.js` și `lib/anaf.js`.

| # | rule-id | Etichetă (RO) | Joburi | % | Severitate | Tier |
|---|---|---|---:|---:|---|---|
| 1 | `salary_missing` | Fără informație de salariu | 58.684 | 100,00% | info | A |
| 2 | `not_verified` | Locație neverificată vreodată | 58.684 | 100,00% | info | A |
| 3 | `loc_needs_rewrite` | Locație necanonică (corectabilă) | 55.864 | 95,19% | medie | C |
| 4 | `title_no_cor` | Titlu fără cod COR | 35.502 | 60,50% | mică | C |
| 5 | `dup_title_company` | Duplicat (titlu+companie) | **18.490** | **31,51%** | **mare** | C |
| 6 | `cif_no_company_doc` | CIF fără fișă de companie | **9.410** | **16,04%** | **mare** | B |
| 7 | `entity_in_company` | Entități HTML în companie | 3.677 | 6,27% | medie | B |
| 8 | `loc_junk` | Locație inexistentă (junk) | 2.212 | 3,77% | mare | C |
| 9 | `entity_in_title` | Entități HTML în titlu | 1.865 | 3,18% | medie | C |
| 10 | `entity_in_url` | Entități HTML în URL | 639 | 1,09% | mare | B |
| 11 | `workmode_missing` | Fără mod de lucru | 241 | 0,41% | mică | A |
| 12 | `tags_missing` | Fără etichete | 236 | 0,40% | mică | A |
| 13 | `loc_international` | Locație străină marcată „Romania" | 200 | 0,34% | medie | C |
| 14 | `gambling_content` | Jocuri de noroc / cazino | 95 | 0,16% | medie | A |
| 15 | `adult_content` | Conținut adult / videochat | **42** | 0,07% | **mare** | A |
| 16 | `loc_junk_numeric` | Adresă de stradă în câmpul localitate | 10 | 0,02% | medie | C |
| 17 | `cif_bad_checksum` | CIF cu sumă de control invalidă | 6 | 0,01% | mare | A |
| 18 | `url_not_http` | URL care nu e absolut | 5 | 0,01% | mare | A |
| 19 | `title_has_phone` | Telefon în titlu | 5 | 0,01% | medie | C |
| 20 | `title_too_short` | Titlu ≤3 caractere | 2 | 0,00% | mică | C |
| 21 | `title_has_email` | Email în titlu | 2 | 0,00% | medie | C |
| 22 | `link_dead` | Link 404/410 | 0 din 114 verificate | — | mare | D |
| 23 | `title_shouting` | Titlu cu MAJUSCULE | 9.698 | 16,53% | **cosmetic** | C |

### Reguli testate și RESPINSE (volum real zero — a nu se implementa)

Fiecare a fost interogată; toate returnează 0. Le documentez ca să nu fie reinventate:

| Regulă candidat | Rezultat |
|---|---|
| `expirationdate` expirat | câmpul are **0 documente** — nu se poate evalua |
| `date` în viitor | 0 |
| `date` absurd de vechi (<2020, <2024) | 0 — **toate cele 58.684 de date sunt în 2026** |
| `cif` lipsă | 0 — CIF e prezent pe 100% |
| `cif = "0"` (placeholder) | 0 |
| `location` lipsă | 0 |
| `title` / `company` / `url` lipsă | 0 |
| titlu doar cifre | 0 |
| titlu cu URL | 0 |
| entități HTML în locație | 0 |
| `workmode` cu valoare nerecunoscută | 0 — doar `on-site` 56.362 / `remote` 1.050 / `hybrid` 1.031 |
| `source` / `vdate` | câmpuri cu 0 documente |

Sfaturile actuale despre „cif=0" și „CIF invalid" (`server/api.js:664-690`) se declanșează pe reguli care nu pot produce nimic pe datele astea.

### Reguli noi, importante, pe care nimeni nu le calcula

**`cif_no_company_doc` — 9.410 joburi (16,04%).** Cea mai valoroasă descoperire a auditului. Un job din șase are un CIF care **nu are fișă în core-ul `company`** — nu poate fi îmbogățit, nu poate fi verificat la ANAF, nu poate fi legat de pagina firmei. 1.320 de CIF-uri distincte.

Cazuri reale:
```
01283100  ALEXANDRA SRL                    2.047 joburi
06646907  PROHUMAN APT S.R.L.              1.264
08184529  SIAD ROMANIA SRL                   619
06668000  PALAS COM SRL                      517
06205722  PREMIER RESTAURANTS ROMANIA SRL    114
02816464  DEDEMAN SRL                         93
08971726  VODAFONE ROMANIA SA                 90
```
Tiparul e evident: **CIF-uri cu zero la început.** Sunt companii mari, reale (Dedeman, Vodafone) — deci nu CIF-ul e greșit, ci **join-ul**: core-ul `company` le stochează probabil fără zeroul din față. Bug de integrare, nu de date.

Reversul: **7.707 din 16.117 fișe de companie (47,8%) nu au niciun job.** Aproape jumătate din core-ul `company` este balast.

**`entity_in_url` — 639 joburi.** Entități HTML în **uniqueKey**. Grav: `&amp;` într-un url înseamnă că re-scraping-ul generează o cheie diferită → duplicate în loc de update. Contribuie direct la cele 18.490 de duplicate.

**`url_not_http` — 5 joburi** cu urluri relative (`/candidate/widget/...`) și unul `mailto:hr@reinert-romania.ro`. Nefolosibile ca linkuri.

### Sfaturi: problema reală nu e conținutul, e lipsa drill-down-ului

`buildTips()` (`server/api.js:600-775`) **construiește deja** un câmp `evidence` cu exemple pe fiecare sfat. Frontend-ul (`public/app.js:860-875`) randează doar `title` și `detail` — **`evidence` este aruncat integral.** De aceea apare „3 adult jobs" fără joburi.

Al doilea bug: `public/app.js:757` citește lista adult prin `pick(d, ["adultPostings","escortPostings","nsfw"])`, dar `server/api.js:394` o returnează ca **`adultOrEscortTitles`**. Nepotrivire de chei → tabelul adult nu se randează niciodată. Aceeași clasă de bug ca Defectele 2, 3 și 5.

**Fix:** fiecare sfat capătă `issue` (rule-id) + `count`, iar UI-ul randează un buton „vezi cele N joburi" care cheamă `/api/jobs?issue=<id>`. Sfatul nu mai poartă exemple inline — poartă **identitatea regulii**, iar drill-down-ul e uniform.

---

# PARTEA II — ARHITECTURA DRILL-DOWN

## Problema

Regulile se împart în două familii incompatibile la prima vedere:
- unele sunt **o interogare Solr** (`-tags:*`) — se pot pagina nativ, ies gratis;
- altele cer **clasificare în JS** (`lib/locations.js`, `lib/cor.js`, potrivire de duplicate) — Solr nu le poate exprima.

Iar un drill-down nu are voie să rescaneze 58.684 de documente la fiecare click.

## De ce nu merge soluția evidentă

Tentația este: clasifici în JS, obții valorile proaste, apoi construiești o interogare Solr din ele. **Pentru `location` acest lucru eșuează catastrofal**, și am măsurat-o:

```
valoare junk reală "Romania"           -> 1.033 joburi
location:"Romania" (phrase query)      -> 58.002 joburi     (de 56 de ori mai mult)

valoare junk reală "Remote, Romania"   -> 743 joburi
location:"Remote, Romania"             -> 759 joburi        (over-match)
```

Cauza: `location`, `title`, `salary`, `tags` sunt **`text_general` — tokenizate**. O interogare de frază se potrivește pe token-uri, nu pe valoarea stocată întreagă. Pe `location` asta e fatal, fiindcă „Romania" apare ca token în aproape fiecare valoare.

Prin contrast, `url`, `company`, `cif`, `workmode`, `status` sunt **`string` — netokenizate**, deci o interogare `cif:("A" OR "B")` este **exactă**. Verificat: `cif_bad_checksum` prin OR exact = 6, identic cu JS-ul.

Limită descoperită prin bisecție: **`maxBooleanClauses` = 1024** (1.024 OK, 1.025 → HTTP 400).

## Soluția: registru de reguli cu patru tier-uri, o singură interfață

Fiecare regulă declară **cum își produce mulțimea**. Endpoint-ul nu știe și nu-i pasă.

```js
// lib/rules.js
{
  id: "loc_junk",
  label: "Locație inexistentă (junk)",
  severity: "high",
  tier: "C",
  describe: "Valoare de locație pe care lib/locations.js nu o recunoaște ca loc real",
  // exact UNA dintre următoarele:
  solrQuery: "-tags:*",                       // tier A
  vocabulary: { field: "cif", predicate },    // tier B
  predicate: (doc, ctx) => boolean,           // tier C
  external: () => urls[],                     // tier D
}
```

### Tier A — interogare Solr pură (7 reguli)

`solrQuery` este un string. Contorul e `count(q)`; drill-down-ul e `q` + `start`/`rows`. **Fără materializare, fără cache, mereu proaspăt.** Paginare nativă Solr.

Validat că interogarea Solr dă exact cifra JS:
```
salary_missing    -salary:*      58.684  = JS 58.684  ✓
tags_missing      -tags:*           236  = JS 236     ✓
workmode_missing  -workmode:*       241  = JS 241     ✓
url_not_http      -url:http*          5  = JS 5       ✓
gambling_content  title:(cazino OR casino OR ...)  95 = JS 95  ✓
adult_content     title:(... OR videochat ...)     42 = JS 42  ✓
cif_bad_checksum  cif:("..." OR ...)                6 = JS 6   ✓
```

### Tier B — vocabular de câmp `string` → interogare exactă (3 reguli)

Câmpul e `string`, deci un facet dă **valorile întregi**. Se aplică predicatul JS peste vocabular (mii de valori, nu zeci de mii de documente), rezultă o listă de valori, iar interogarea `field:("v1" OR "v2" ...)` este **exactă**.

Pentru >1024 valori se sparge în batch-uri și se însumează / se paginează peste batch-uri.
- `cif_no_company_doc`: 1.320 valori → 2 batch-uri
- `entity_in_company`: 9.728 valori de verificat → 10 batch-uri
- `entity_in_url`: pe `url`, uniqueKey

Cost: un facet + un predicat pe vocabular. Ordine de mărime mai ieftin decât un scan.

> Atenție la capcană: `company:*amp*` (wildcard) dă **3.600**, nu 3.677 — ratează `&quot;`, `&#39;` etc. Doar OR-ul exact peste vocabularul din facet e corect.

### Tier C — clasificare JS, materializată (11 reguli)

Singura familie care are nevoie de scan. Cheia: **un singur scan comun produce TOATE regulile Tier C simultan**, nu unul per regulă.

```
Scan complet 58.684 documente, toate cele 11 reguli deodată: 9,8 s
```

Rezultatul se materializează ca **`ruleId -> url[]`** (url este uniqueKey), pe disc în `cache/issues.json`, cu TTL de 10 minute și invalidare după orice scriere.

Drill-down-ul devine: se feliază array-ul de urluri cu `offset`/`limit`, apoi un singur `url:(...)` batch (≤1024 clauze, iar o pagină are 50–200) pentru rândurile reale.

**Măsurat: 6 ms pentru 50 de rânduri la offset 500.**

Memoizarea contează: `classify()` se apelează o dată per **valoare distinctă** (4.937), nu per document (58.684); `matchTitle()` o dată per titlu distinct (29.568). De aceea scan-ul stă la 9,8 s.

Dimensiune index materializat: **16,9 MB pentru 20 de reguli** — dominat de `salary_missing` (toate cele 58.684 de urluri, care sunt lungi). **Optimizare obligatorie: regulile Tier A nu se materializează niciodată** — au deja `solrQuery`. Fără cele două reguli de 100%, indexul scade sub ~4 MB.

### Tier D — sursă externă (1 regulă)

`link_dead` se citește din `cache/links.json` (verificări de rețea, nu se pot recalcula la cerere). Produce urluri; se îmbogățește prin același `fetchByUrls`. Endpoint-ul răspunde și cu `checked`/`coveragePct`, ca lista să nu mintă despre acoperire.

### Interfața unificată

```js
async function resolve(rule, { offset = 0, limit = 50, sort }) {
  switch (rule.tier) {
    case "A": return solrPage(rule.solrQuery, offset, limit, sort);
    case "B": return solrPage(vocabularyQuery(rule), offset, limit, sort);
    case "C": {
      const urls = (await materialized())[rule.id];        // cache 10 min
      return { total: urls.length, rows: await fetchByUrls(urls.slice(offset, offset + limit)) };
    }
    case "D": {
      const urls = rule.external();
      return { total: urls.length, rows: await fetchByUrls(urls.slice(offset, offset + limit)) };
    }
  }
}
```

Un apelant. Patru strategii. **Aceeași formă de răspuns pentru toate.**

---

# PARTEA III — SUPRAFAȚA API PROPUSĂ

## Endpoint-ul central (NOU) — `GET /api/jobs`

Fiecare număr din aplicație se rezolvă într-un apel aici.

```
GET /api/jobs?issue=loc_junk&offset=0&limit=50&sort=company
GET /api/jobs?issue=loc_junk&value=Remote,%20Romania      # restrânge la o valoare
GET /api/jobs?q=company:"GEORGIANA SRL"                   # interogare liberă
```

| Parametru | Implicit | Note |
|---|---|---|
| `issue` | — | rule-id din registru |
| `value` | — | opțional; restrânge la o valoare (ex. o locație junk anume) |
| `offset` / `limit` | 0 / 50 | limit max 200 |
| `sort` | `date desc` | `company`, `title`, `date` |
| `q` | — | alternativ la `issue`, interogare Solr brută |

```json
{
  "issue": "loc_junk",
  "label": "Locație inexistentă (junk)",
  "severity": "high",
  "tier": "C",
  "describe": "Valoare de locație pe care lib/locations.js nu o recunoaște ca loc real",
  "total": 2212,
  "offset": 0,
  "limit": 50,
  "rows": [
    {
      "url": "https://8ore.ro/locuri-de-munca/asistenta-manager",
      "title": "Asistenta manager",
      "company": "DOX FILM SRL",
      "cif": "14988196",
      "location": ["Romania"],
      "workmode": "on-site",
      "salary": null,
      "date": "2026-...",
      "status": "scraped",
      "flaggedBy": ["loc_junk"],
      "why": "not-a-place: \"Romania\" nu este o localitate"
    }
  ],
  "generatedAt": "2026-08-24T...",
  "cacheAgeMs": 0
}
```

`flaggedBy` este cheia UX: un rând poate încălca mai multe reguli deodată, iar tabelul le arată pe toate ca badge-uri.

## `GET /api/issues` (NOU) — registrul, cu contoare

Alimentează atât ecranul de ansamblu, cât și tab-ul de sfaturi. O singură sursă de adevăr.

```json
{
  "total": 58684,
  "generatedAt": "...",
  "issues": [
    { "id": "dup_title_company", "label": "Duplicat (titlu+companie)", "severity": "high",
      "tier": "C", "count": 18490, "pct": 31.51,
      "drilldown": "/api/jobs?issue=dup_title_company",
      "sample": [ { "url": "...", "title": "...", "company": "..." } ] }
  ]
}
```

## Endpoint-uri existente — verdict

| Endpoint | Verdict | Acțiune |
|---|---|---|
| `GET /api/health` | OK | păstrat |
| `GET /api/overview` | corect în backend | se adaugă `unverifiedByAbsence`; se repară consumatorul din frontend |
| `GET /api/fields` | corect | fiecare `problems[]` capătă `issue` + `drilldown` |
| `GET /api/complete` | metrică defectă | se exclude `salary` din câmpurile obligatorii |
| `GET /api/warnings` | **înlocuit** | devine un alias subțire peste `/api/issues` |
| `GET /api/locations` | produce datele, cheile nu se potrivesc | fiecare bucket capătă `examples[]` + `issue`; se scoate tăierea la 30 |
| `GET /api/locations/proposed` | OK | se adaugă `offset`/`limit` (azi tăiat rigid la 300 din 4.739) |
| `GET /api/companies` | slab (doar top 30) | se adaugă `offset`/`limit` + `issue` per flag |
| `GET /api/salary` | onest în backend | se elimină `distribution`; se adaugă `drilldown` către cele 530 |
| `GET /api/links` | rupt | array + îmbogățire din Solr + `coveragePct` |
| `GET /api/occupations` | OK | `unmatchedTitles` capătă `drilldown` (`issue=title_no_cor`) |
| `GET /api/tips` | evidence aruncat | fiecare sfat capătă `issue` + `count` |
| `POST /api/chat` | **rupt** | semnătură `({ body })` |
| `POST /api/normalize` | **rupt** | semnătură `({ body })` |
| `/api/action/*` | OK | păstrate |

**Regulă generală:** fiecare endpoint care returnează o listă acceptă `offset`/`limit` și returnează `{total, offset, limit, rows[]}`. Fără tăieri rigide invizibile (azi: locations 30, proposed 300, companies 30, occupations 30).

## Bug latent găsit în trecere — `lib/solr.js:65`

```js
`/select?...&sort=url+asc&cursorMark=...`
```
`scan()` codifică rigid `sort=url asc`. Core-ul `company` **nu are câmp `url`** → orice `scan()` pe el moare cu HTTP 400. M-am lovit de asta în audit. `scan()` trebuie să accepte câmpul de sortare ca parametru (implicit uniqueKey-ul core-ului).

---

# PARTEA IV — LISTA DE LUCRU, ORDONATĂ DUPĂ IMPACT

### P0 — trei linii, deblochează funcții întregi (< 30 min)

1. **`server/api.js:787`** → `async function postChat({ body })` — **învie tab-ul Asistent.** Verificat că funcționează.
2. **`server/api.js:805`** → `async function postNormalize({ body })` — **învie normalizarea**, care poate scrie apoi `verified`/`junk`/`international` și repară implicit donut-ul.
3. **`server/api.js:544`** → `async function getLinks({ query })` — face `?limit=` funcțional.

Raport cost/beneficiu imbatabil: trei semnături, două tab-uri moarte reînviate.

### P1 — reparat afișarea zerourilor și a listelor goale (2–3 h)

4. **`public/app.js:346`** — coverage citit ca `{filled, filledPct}`. *Elimină cele 10 zerouri din screenshot.*
5. **`lib/analytics.js:242`** — `-verified:*` în loc de `verified:false`. *Donut-ul: „58.684 neverificate (100%)" în loc de 0/0/0/0.*
6. **`public/app.js:298`** — se citește `d.bad.junk` / `d.bad.foreign` / `d.bad.fake`. *Locațiile proaste devin vizibile — 2.212 junk + 200 internaționale.*
7. **`public/app.js:824`** — linkurile ca array, filtrate pe `classification === "dead"`. *Dispar rândurile de „?".*
8. **`public/app.js:757`** — `adultOrEscortTitles`, numele real al cheii.
9. **`server/api.js:373`** — `videochat OR "video chat"` în `ADULT_QUERY`. *11 → 42 joburi, +282%.*
10. **`server/api.js:539`** — `salary` scos din definiția „complet". *0% → 99,41% (58.336 joburi, măsurat).*

Toate patru bug-urile de afișare sunt **aceeași clasă**: frontend-ul ghicește nume de chei cu `pick(...)` și, când nu nimerește, cade tăcut pe zero sau pe listă goală. `pick()` ar trebui să logheze în consolă când niciun candidat nu se potrivește — bug-urile astea ar fi fost prinse instant.

### P2 — motorul de drill-down (1–2 zile)

11. `lib/rules.js` — registrul, cele 4 tier-uri, cele 22 de reguli reținute.
12. `lib/issues.js` — scan comun + materializare în `cache/issues.json` (Tier C), TTL 10 min. **Tier A nu se materializează.**
13. `GET /api/jobs` — endpoint-ul unic de drill-down.
14. `GET /api/issues` — registrul cu contoare.
15. `fetchByUrls()` — helper batch (≤1024 clauze).
16. **`lib/solr.js:65`** — `scan()` cu câmp de sortare parametrizat.
17. UI: fiecare contor devine apăsabil; un tabel de joburi refolosibil, cu badge-uri `flaggedBy`.

### P3 — onestitate în conținut (0,5 zi)

18. Tab „Salarizare" degradat: histograma **eliminată**, banner de 0,00% / 0,90%, lista drilabilă a celor 530, avertisment explicit că eșantionul e dominat de anunțuri de bone.
19. Avertismente reordonate: `dup_title_company` (31,51%) și `cif_no_company_doc` (16,04%) sus; `title_shouting` (16,53%) retrogradat la „cosmetic".
20. Se șterg regulile moarte: `cif-zero`, `cif missing`, `invalid workmode`, orice pe `expirationdate`/`date` — toate 0 pe acest index.
21. Sfaturile poartă `issue` + `count`; UI-ul randează „vezi cele N joburi".

### P4 — investigații deschise de audit (nu sunt bug-uri de dashboard)

22. **Join-ul CIF cu zero la început.** 9.410 joburi (16,04%) nu se leagă de core-ul `company`; tiparul e `0xxxxxxx`. Probabil zeroul din față se pierde la una din părți. **Cea mai valoroasă reparație de date din tot auditul.**
23. **639 de urluri cu entități HTML** în uniqueKey → re-scraping-ul creează duplicate în loc de update. Contribuie direct la cele 18.490.
24. **47,8% din core-ul `company` (7.707 fișe) nu are niciun job.**
25. **Salariul trebuie reparat în ingestie**, nu în dashboard: scraper-ele iau doar cardul de listare, nu pagina de descriere.
26. **Feed-ul global Workday** (`kone.wd3.myworkdayjobs.com`) intră integral în index-ul RO — sursa majorității celor 200 de locații internaționale.

---

## ANEXĂ — cum se reproduce fiecare cifră

Toate măsurătorile provin din:
- interogări directe `POST /solr/job/select` (contoare, facet-uri, sondarea `maxBooleanClauses`);
- un scan complet cu `lib/solr.js scan()` + `lib/locations.js classify()` + `lib/cor.js matchTitle()` + `lib/anaf.js isStructurallyValid()`, memoizat pe valori distincte (9,8 s pentru toate cele 20 de reguli);
- `cache/links.json` pentru starea linkurilor;
- apeluri live către `http://localhost:7777/api/*` pentru formele de răspuns;
- un server temporar pe :7799 pentru a demonstra fix-ul de chat end-to-end fără a modifica repo-ul.

Nicio cifră din acest document nu este estimată. Fiecare afirmație „N joburi" a fost măsurată pe index-ul de 58.684 de documente la data auditului.
