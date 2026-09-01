# SOLR DOCTOR — analiză UI și propunere de redesign

**Data:** 24 august 2026
**Stare:** propunere pentru aprobare. Nimic nu a fost rescris încă.
**Livrabile:** acest document + prototipul funcțional `public/prototype.html` (http://localhost:7777/prototype.html)

---

## 0. Principiul care guvernează tot redesignul

> „Când arăți chestii în neregulă, dă fetch și la joburile alea.”

Aplicația este o **privire de ansamblu peste toată baza de date**. De fiecare dată când raportează
o problemă, trebuie să poată aduce și afișa **documentele reale din spatele cifrei**.

Din asta rezultă o regulă unică, non-negociabilă, care structurează întreaga interfață:

> **Nu există cifre moarte. Orice număr afișat oriunde în interfață este un control
> care deschide lista de joburi din spatele lui.**

Drill-down-ul nu este „încă un pattern” în design. Este **coloana vertebrală a produsului**.
Tot ce urmează — arhitectura informației, scorul de sănătate, graficele, tokenii — există
ca să susțină acest gest: *văd o problemă → văd rândurile → acționez*.

---

## 1. Critica interfeței actuale

Toate observațiile de mai jos sunt verificate pe aplicația care rulează, comparând
DOM-ul randat cu răspunsurile reale ale API-ului.

### 1.1 Două bug-uri de randare produc majoritatea „interfeței proaste”

Nu este doar o problemă de estetică. Ecranul principal afișează date **false**.

**Bug A — toate barele de acoperire arată 0.**

`/api/fields` întoarce:

```json
{"fields":{"url":{"filled":58684,"filledPct":100}, "title":{"filled":58684,"filledPct":100}, ...}}
```

`public/app.js:355` caută însă altceva:

```js
const pct    = pick(f, ["pct", "coverage", "percent"], null);   // filledPct NU e în listă → null
const filled = pick(f, ["filled", "count", "value"], null);     // "value" există pe wrapper → OBIECT
return { label: name || "?", value: pct !== null ? Number(pct) : Number(filled) || 0 };
```

`asArray()` transformă mapa în `[{key:"url", value:{...}}]`. `pick` găsește cheia `value`
(wrapper-ul, nu câmpul), returnează un **obiect**, iar `Number(obiect) || 0` dă **0**.
Rezultat: cardul „Acoperire câmpuri” arată `url 0, title 0, company 0, cif 0…`
deși în realitate toate sunt la 100%. **Interfața raportează o bază de date goală peste una completă.**

**Bug B — lista de linkuri moarte este 100% fabricată.**

`/api/links` întoarce `results` ca **obiect indexat după URL**, iar rândurile conțin
doar `{url, host, status, result, ms, checked}` — **fără `title`, fără `company`**.

`app.js:825`:

```js
const dead = asArray(pick(d, ["dead","notFound","results"], []))
  .filter((x) => typeof x !== "object" || !("status" in x) || x.status === 404 || x.dead);
```

După `asArray`, fiecare element este `{key, value}`. Cheia `status` **nu există pe wrapper**,
deci `!("status" in x)` este `true` și **fiecare link trece filtrul „mort”**.
Apoi `u.url` este `undefined` (URL-ul e în `u.value.url`) → se afișează `"?"`,
iar statusul lipsă cade pe literalul hardcodat `"404"`.

Rezultat: coloana de „?”-uri reclamată de utilizator. În realitate, la ultima rulare
**toate cele 50 de linkuri verificate au răspuns 200 OK — zero linkuri moarte.**
Tabelul inventează un incident inexistent.

**Cauza comună:** `app.js` este scris cu helperi „ghicitori” (`pick` cu liste de nume alternative,
`asArray` care înghite orice) în loc să consume contractul real al API-ului. Când ghicitul dă greș,
**eșuează silențios în `0` și `"?"`** în loc să eșueze zgomotos. Este cel mai grav defect
al aplicației și trebuie eliminat prin tipare explicite, nu prin încă un nume în listă.

### 1.2 Donutul 0/0/0/0 nu e bug de UI — e o măsurătoare care nu există

`/api/overview` întoarce sincer `verified:0, unverified:0, international:0, junk:0`.
Clasificarea locațiilor **nu rulează**. Interfața desenează totuși un grafic cu patru felii goale.

Aceasta este exact greșeala pe care literatura de vizualizare o numește **„Misleading”** —
a codifica datele lipsă ca zero. Studiul *Where's My Data? Evaluating Visualizations with Missing Data*
(Song & Szafir, IEEE VIS 2018) compară trei strategii — *Misleading* (lipsă = 0),
*Absent* (omitere) și *Coded* (omitere + explicația motivului) — și găsește că
**„emptiness plus explanation”** produce cea mai mare încredere în decizie.
Regula pentru noi: **zero măsurat ≠ nemăsurat**, iar cele două nu au voie să arate la fel.

### 1.3 Graficele

- **Barele orizontale** (`hbarChart`, `app.js:180`) nu au axă, nu au gridlines, nu au scală.
  `labelW` este fix 190px într-un `viewBox` de 640 — pe mobil SVG-ul se scalează și textul
  devine ilizibil. Nu se poate citi „cât de mare” e o bară, doar ordinea.
- **Distribuția salariilor** randează doar etichetele intervalelor (`0-2000`, `2000-3000`…)
  fără valori vizibile — grafic gol cu legendă.
- **Ocupații COR** cade complet pe fallback: *„/api/occupations (format neașteptat, afișat ca atare)”*.

### 1.4 Aceeași întrebare, trei răspunsuri diferite

„Câte joburi au salariu?” primește simultan:

| Sursă | Răspuns |
|---|---|
| `/api/overview` → `fieldCoverage.salary` | 0 joburi (0%) |
| `/api/salary` → `withSalary` | 530 joburi (0,9%) |
| `/api/tips` | „58684 of 58684 jobs carry no parseable salary” (100% lipsă) |

Toate trei apar în interfață, în taburi diferite, fără nicio notă care să le împace.
(Explicația reală: câmpul `salary` este gol în 100% din documente, dar un parser găsește
sume în **titlu** la 530 dintre ele. Interfața nu spune asta nicăieri.)

### 1.5 Avertismentele semnalează fleacuri, nu lucruri importante

Tabul **Avertismente** deschide cu „titluri CAPS LOCK: 9.731” — cosmetic — și afișează
50 de rânduri cu motivul `shouting`. În același timp:

- `fără CIF: 0 (0%)` — deși `/api/tips` raportează **4.735 CIF-uri care pică checksum-ul oficial**
  (valori structural imposibile ca CUI românesc, ex. `99999999`, `2751201014312`);
- **11 anunțuri pentru adulți** (OnlyFans, escort) — încălcare de politică pe un board generalist —
  sunt îngropate în tabul *Sfaturi*, nu în *Avertismente*.

Ierarhia este inversată: fleacul e titlu, încălcarea de politică e subsol.

### 1.6 Nimic nu este drilabil — reclamația centrală

Interfața raportează numere și se oprește acolo. „11 joburi adult” — **care**?
Utilizatorul nu poate ajunge la rânduri din nicio cifră, în niciun tab.
Singurele rânduri concrete existente (`/api/tips` → `evidence.examples`) conțin
`url`, `title` și `company` reale, dar sunt afișate ca text, nu ca tabel navigabil.
**Datele pentru drill-down există deja în backend; interfața pur și simplu nu le expune.**

### 1.7 Locațiile — cea mai mare problemă reală de date, tratată superficial

Din `/api/locations`:

```
"Bucuresti, Romania"  → 10.763        "București, Romania" → 2.076
"Galati, Romania"     →  1.028        "Olanda, Romania"    →     14
```

Același oraș apare de două ori pentru că diacriticele produc fațete diferite în Solr,
iar țări străine sunt etichetate `, Romania`. Interfața le listează ca pe niște rânduri
oarecare, fără să spună că sunt **aceeași localitate** sau **greșeli de țară**.

### 1.8 Diverse

- **Entități HTML dublu-escapate**: `IONUT&amp;MADA S.R.L.` se afișează literal.
- **Sfaturile sunt în engleză** într-o interfață integral românească.
- **`index.html` nu are nicio diacritică**: „Prezentare generala”, „Locatii”, „sanatatii”.
- **Stările goale** spun „API-ul nu a raportat… — sau câmpurile respective nu există în răspuns”,
  ceea ce sună a defect, nu a informație.
- **Mobil**: un singur `@media (max-width:640px)` în tot CSS-ul; bara cu 8 taburi și tabelele largi
  nu au tratament real.
- **Acțiuni distructive**: `✕ șterge` (golește tot indexul) stă în bara de sus,
  la 30px de `↻ reîncarcă`, cu aceeași greutate vizuală.

---

## 2. Research — pattern-uri din unelte moderne

### 2.1 Scor de calitate ponderat

[Qualytics](https://userguide.qualytics.io/quality-scores/what-are-quality-scores/) calculează
un scor 0–100 din **opt dimensiuni** (Completeness, Coverage, Conformity, Consistency, Precision,
Accuracy, Timeliness, Volumetrics), cu formule explicite:

- `Completeness = (valori non-null / total) × 100`
- `Conformity   = (1 − rânduri anormale / rânduri scanate) × 100`
- `Coverage     = 100 × (1 − e^(−k·n))` — curbă cu randamente descrescătoare, unde *n* = numărul de verificări

[Collibra](https://www.collibra.com/blog/the-6-dimensions-of-data-quality) și
[iceDQ](https://icedq.com/6-data-quality-dimensions) folosesc setul clasic de 6 dimensiuni,
iar formula agregată uzuală este `[1 − (înregistrări proaste / total)] × 100`.

**Transferabil:** scorul global depinde **doar** de scorurile pe dimensiuni, iar ponderile
sunt configurabile după importanța de business. Asta ne permite să dăm ALL-CAPS pondere 3
și conținutului adult pondere 20 — și să justificăm numeric de ce.

### 2.2 Liste de verificări cu pass/fail și dovezi

[Great Expectations](https://www.dataexpert.io/blog/soda-vs-great-expectations-data-quality-tools)
generează *Data Docs* — rapoarte HTML lizibile care funcționează ca documentație vie a calității.
[Soda](https://qaskills.sh/blog/soda-data-quality-testing-guide-2026) rulează checks declarative
și tipărește pass/fail per verificare. Cel mai relevant pattern vine din **dbt tests**:
testul este o interogare SQL, iar **rândurile returnate SUNT eșecul** — dacă întoarce zero rânduri, trece.

**Transferabil, și direct:** o verificare nu este un număr, ci **o interogare care produce rânduri**.
Numărul este doar `COUNT(*)`-ul acelei interogări. Asta face drill-down-ul nu o funcționalitate
adăugată, ci **forma naturală a modelului de date**: fiecare regulă are un `q` (filtrul Solr),
iar UI-ul afișează fie `numFound`, fie documentele — aceeași interogare, două randări.

### 2.3 Ierarhia panourilor

[Grafana](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/)
recomandă ierarhii explicite *overview → detaliu*, dimensiuni variate ale panourilor (nu totul mare),
KPI-urile principale acolo unde cade prima dată privirea, și structurarea după cadre gen RED
(Rate, Errors, Duration) sau Four Golden Signals.

### 2.4 Date lipsă

Song & Szafir (IEEE VIS 2018), *Where's My Data?* — vezi §1.2.
Concluzia operațională: **omitere + explicație**, niciodată „lipsă = 0”.

### 2.5 Confirmarea acțiunilor distructive

Din [SaaS destructive-action patterns](https://www.saasui.design/blog/saas-destructive-actions-confirmation-ux-patterns)
și [NN/g](https://www.nngroup.com/articles/confirmation-dialog/):

- **scară de fricțiune**: fără confirmare → confirmare simplă → confirmare cu consecințe explicite → *type-to-confirm*;
- fricțiunea se potrivește cu **raza de explozie**, nu se aplică uniform;
- focusul implicit cade pe opțiunea **sigură**;
- dialogurile își pierd puterea dacă sunt frecvente — deci **rar și serios**.

---

## 3. Propunerea de redesign

### 3.1 Arhitectura informației

Bara plată cu 8 taburi dispare. În loc: **sidebar persistent** grupat pe intenție.

| Actual | Devine | De ce |
|---|---|---|
| Prezentare generală | **Sănătate** (ecran principal) | devine scorul + verificările care pică |
| Avertismente + Sfaturi | **Toate verificările** | erau același lucru împărțit arbitrar în două taburi |
| Locații | **Locații** (tratament de rang întâi) | cea mai mare problemă reală de date |
| Companii | **Companii** | rămâne |
| Salarizare | **Salarizare** | rămâne, dar onest despre sparsitate |
| Ocupații | **Ocupații COR** | rămâne |
| *(nou)* | **Linkuri** | exista doar îngropat în Avertismente |
| Asistent | **Asistent** (panou docat) | vezi §3.8 |

```
Diagnostic          Explorare              Unelte
  Sănătate  ⬤5        Locații  ⬤4            Asistent
  Toate verificările  Companii
                      Salarizare
                      Ocupații COR
                      Linkuri  ⬤0
```

**Merge:** *Avertismente* + *Sfaturi* → **Toate verificările**. Erau redundante:
ambele listau probleme, cu praguri diferite și în limbi diferite.
**Nou:** *Linkuri* ca secțiune proprie. **Promovat:** *Locații*.

Ecranul **Sănătate** trebuie să spună povestea completă **în primul ecran, fără scroll**:
*asta e starea bazei de date → asta e stricat, ordonat după cât contează → fiecare linie deschide dovada*.
În prototip, blocul scor + lista completă de verificări se termină la **507px** pe 1280×800.

### 3.2 Scorul de sănătate — coloana vertebrală

Un singur număr, 0–100, media ponderată a verificărilor:

```
scor = Σ(pondere_i × scor_i) / Σ(pondere_i)
scor_i = (1 − afectate_i / total) × 100
```

Benzi: **0–39 critic** (roșu) · **40–69 fragil** (galben) · **70–89 acceptabil** ·
**90–100 sănătos** (verde).

Sub scor, patru **dimensiuni** (subset pragmatic din cele 6–8 clasice, doar cele
pe care backendul le poate calcula azi): Completitudine · Validitate · Consistență · Conformitate.

Registrul de verificări propus (ponderile sunt punctul de plecare pentru discuție):

| # | Verificare | Pondere | Afectate | Sursă |
|---|---|---|---|---|
| 1 | Salariul lipsește | 25 | 58.154 | `/api/salary` |
| 2 | Conținut pentru adulți | 20 | 11 | `/api/tips` |
| 3 | CIF pică checksum-ul | 15 | 4.735 | `/api/tips` |
| 4 | Localități duplicate prin diacritice | 12 | 12.839 | `/api/locations/proposed` |
| 5 | Entități HTML în nume companii | 8 | 2.635 | `/api/companies` → `flagged` |
| 6 | Linkuri moarte | 10 | 0 | `/api/links` |
| 7 | Titluri cu punctuație/emoji | 7 | ~n | `/api/fields` |
| 8 | Titluri ALL CAPS | **3** | 9.731 | `/api/fields` |

Ponderea 3 pentru ALL-CAPS este **rezolvarea explicită** a reclamației „semnalează fleacuri”:
verificarea rămâne (informația e reală), dar nu mai poate domina nici scorul, nici ecranul.

**Regulă de onestitate:** o verificare care nu a rulat afișează `—` cu eticheta
**„nemăsurat”** și este **exclusă din numitor**. Nu contribuie cu 0. Scorul spune atunci
„62 din 100, pe baza a 7 din 8 verificări”.

### 3.3 Pattern-ul de drill-down

**Model:** fiecare regulă = `{ cheie, nume, de_ce, severitate, pondere, q, acțiune? }`,
unde `q` este filtrul Solr. `COUNT(q)` dă cifra; `SELECT(q)` dă rândurile. O sursă, două randări.

**Afordanță vizuală unică**, aplicată oricărei cifre drilabile — subliniere punctată,
cursor pointer, `↗` în superscript, halou la hover:

```css
.drillable{cursor:pointer;border-bottom:1px dashed currentColor;border-radius:3px;}
.drillable:hover{background:var(--accent-soft);box-shadow:0 0 0 3px var(--accent-soft);}
.drillable::after{content:"↗";font-size:.7em;margin-left:3px;opacity:.6;vertical-align:super;}
```

**Implementare:** un singur listener delegat pe `document` pentru `[data-drill]`.
Orice element — `<span>`, `<button>`, `<rect>` SVG, rând de tabel — devine drilabil
adăugând un atribut. Prototipul are **36 de elemente drilabile** fără niciun handler individual.

**Puncte de intrare demonstrate în prototip (aceeași destinație, gesturi diferite):**
1. cifra dintr-o verificare din lista de sănătate;
2. **orice element din orice grafic** — vezi §3.5.1;
3. o **găleată de locații** și o **cifră dintr-un rând de tabel** (diff-ul înainte→după);
4. cifre inline din textul paragrafului de rezumat.

Prototipul are **64 de elemente drilabile**, toate servite de un singur listener delegat.

#### Panoul de joburi: **drawer lateral dreapta**, nu modal, nu sub-pagină

Justificare față de comportamentul real (utilizatorul face naveta constant între agregat și rânduri):

| Opțiune | Verdict |
|---|---|
| Sub-pagină rutată | ✗ pierde contextul agregat; înapoi/înainte la fiecare inspecție; cel mai scump gest |
| Modal centrat | ✗ blochează tot ecranul, se simte terminal, ascunde exact cifra din care ai venit |
| **Drawer lateral** | ✓ agregatul rămâne vizibil în stânga, `Esc` închide instant, comparația între două reguli costă două click-uri |

Lățime `min(940px, 100vw)`; pe mobil devine full-screen. Se poate lega adânc prin
`#drill=<cheie>` (partajabil), fără a schimba pagina.

**Conținutul panoului:**
- **Antet:** numele regulii, ponderea, și **de ce a fost marcat rândul** — în cuvinte, nu jargon.
- **Coloane:** Titlu · Companie · Locație · Salariu · Data · URL · **Semnal**.
  Coloana *Semnal* poartă badge-ul regulii care a prins rândul (`onlyfans`, `diacritice`, `CIF invalid`).
- **Sortare** pe orice coloană; **filtrare** text live.
- **Paginare** 25/50/100 pe pagină, cu prima/ultima. Pentru zeci de mii de rânduri:
  server-side prin `start`/`rows` din Solr, plus randare pe ferestre.
  Subsolul spune sincer `Rândurile 1–50 din 600 · eșantion încărcat din 58.154 totale`.
- **Link extern** către anunțul original (`target="_blank" rel="noopener"`).
- **Export CSV** al selecției curente (cu filtrul aplicat).
- **Acțiune pe rând**, unde există: „Acceptă” pentru o normalizare de locație propusă.
  Acțiunile în masă cer confirmare scrisă (§3.7).

### 3.4 Locații — rang întâi

Cinci găleți vizibile simultan, ca bară stivuită **+** carduri, fiecare cu cifră **și** listă drilabilă:

| Găleată | Culoare | Ce conține |
|---|---|---|
| **Corectate** | verde | identificate în SIRUTA, scrise canonic cu diacritice |
| **De corectat** | albastru | au o normalizare propusă, în așteptare |
| **Neidentificate** | galben | par localități, fără corespondent SIRUTA |
| **Junk** | roșu | `Remote`, `Romania` fără oraș, `-`, text liber |
| **Internaționale** | mov | `Olanda, Romania` — țară greșită |

Sub ele, **diff-ul înainte → după**:

```
Bucuresti, Romania  →  București   [diacritice]   10.763 ↗   [Acceptă]
Galati, Romania     →  Galați      [diacritice]    1.028 ↗   [Acceptă]
Olanda, Romania     →  Olanda (internațional)      [țară greșită]  14 ↗  [Acceptă]
```

Cifra din coloana „Joburi” este ea însăși drilabilă: vezi exact ce se schimbă **înainte** să accepți.

### 3.5 Graficele sunt controale, nu ilustrații

**Cerință fermă:** fiecare element grafic — bară, coloană, segment de bară stivuită —
poartă **propriul filtru** și, la click, **deschide joburile reale din spatele acelei felii**
prin exact același drawer ca orice altă cifră. Nu tooltip. Nu un contor filtrat. **Rândurile.**

| Gest | Deschide |
|---|---|
| bară din **Top localități** | joburile din acea localitate |
| bară din **Top companii** | joburile companiei respective |
| bară din **Acoperirea câmpurilor** | joburile **cărora le lipsește acel câmp** |
| coloană din **Distribuția salariilor** | joburile din acel interval de salariu |
| segment din **bara stivuită de locații** | joburile din găleata respectivă (junk, internaționale…) |

**Mecanism.** Elementul poartă un identificator de filtru parametrizat:

```
data-drill="loc:Cluj-Napoca|1363"      data-drill="field:tags|235"
data-drill="company:GEORGIANA SRL|3150" data-drill="band:3–4k|101"
```

`resolveRule()` desface `tip:valoare|număr` și construiește regula la cerere; cheile statice
(`adult`, `loc_junk`) trec neatinse. Rezultatul intră în **același** `openDrill()`.
În implementarea reală, fiecare tip se traduce direct într-un filtru Solr
(`fq=city:"Cluj-Napoca"`, `fq=-tags:[* TO *]`, `fq=company:"GEORGIANA SRL"`),
deci graficul și panoul citesc **aceeași interogare**.

**Afordanța trebuie să fie evidentă** — un grafic care arată ca o poză nu invită la click:

```css
.bar-rect[data-drill]{cursor:pointer;}
.bar-rect[data-drill]:hover{opacity:.85;filter:brightness(1.35);
                            stroke:var(--text-1);stroke-width:1.5;}
```

Plus `<title>` pe fiecare element („Cluj-Napoca: 1.363 joburi — click pentru rânduri”),
subtitlul cardului care spune explicit gestul, și — pentru coloanele înguste din histogramă —
o **zonă de click invizibilă pe toată înălțimea coloanei** (`.bar-hit`), ca ținta să fie
utilizabilă și când bara are 4px înălțime.

Pe barele de acoperire, **și pista goală este drilabilă**: partea nedesenată a barei *este*
partea lipsă, deci click pe ea deschide exact joburile fără câmpul respectiv.

### 3.5.1 Inventarul graficelor — și când graficul e greșit

| Metrică | Reprezentare | Motiv |
|---|---|---|
| Acoperire câmpuri | **bare orizontale cu axă 0–100% + gridlines** | comparație între categorii pe scală comună fixă |
| Găleți de locații | **bară stivuită 100% + carduri** | părți dintr-un întreg cunoscut |
| Distribuție salarii | **coloane cu axă Y** + banner de acoperire | histogramă peste intervale ordonate |
| Top localități / companii | **bare orizontale pentru primele 8–10** (drilabile) **+ tabel sortabil pentru restul** | graficul arată forma cozii lungi; tabelul e singurul mod onest de a explora 4.937 / 9.728 de categorii |
| Top coduri COR | **tabel** | idem — 29.575 de titluri distincte |
| Verificate/junk/internaționale | **bară stivuită** — dar **numai când clasificarea rulează** | azi e 0/0/0/0; până atunci → stare „nemăsurat” |
| Monedă (RON/EUR) | **două cifre + procent, fără grafic** | două categorii nu merită un donut |
| Prospețimea datelor | **sparkline** în antet | tendință, nu valoare exactă |

**Donutul dispare complet.** Patru felii, comparație de unghiuri, valori zero — nu are ce oferi
peste o bară stivuită sau două cifre.

**Sparsitatea salariilor tratată onest.** 530 din 58.684 = 0,9%. Nu ascundem graficul,
dar îl încadrăm:

> ⚠ Graficul acoperă **530 de joburi (0,9%)** din 58.684. Nu este reprezentativ pentru piață —
> descrie doar anunțurile care menționează salariul în titlu. **Nu extrapola.**

Axa X poartă `n = 530 din 58.684`. Bara `salary` din graficul de acoperire este roșie la 0,9%
și **se deschide** în cele 58.154 de joburi fără salariu.

### 3.6 Design tokens

Dark rămâne principal, dar **intenționat**: gri albăstrui, nu negru, cu patru trepte de suprafață
care fac ierarhia lizibilă fără linii peste tot.

```css
:root{
  /* suprafețe */
  --bg-0:#0B0E14;  --bg-1:#11151D;  --bg-2:#161B25;  --bg-3:#1D2430;  --bg-4:#252E3C;
  --border:#232B38; --border-strong:#323D4E;
  /* text */
  --text-1:#E8EDF5; --text-2:#9AA7B8; --text-3:#66748A;
  /* semantic */
  --accent:#4C9FFF; --accent-soft:rgba(76,159,255,.14);
  --ok:#3FD07F;     --ok-soft:rgba(63,208,127,.13);
  --warn:#F2B23E;   --warn-soft:rgba(242,178,62,.13);
  --bad:#FF6B5E;    --bad-soft:rgba(255,107,94,.13);
  --info:#8B7BF0;   --info-soft:rgba(139,123,240,.13);
  --unknown:#4A5568; --unknown-soft:rgba(74,85,104,.20);   /* „nemăsurat” — NU e zero */

  /* tipografie */
  --fs-3xs:10px; --fs-2xs:11px; --fs-xs:12px; --fs-sm:13px;
  --fs-md:14px;  --fs-lg:16px;  --fs-xl:20px; --fs-2xl:26px; --fs-3xl:40px;

  /* spațiere — bază 4px */
  --s-1:4px; --s-2:8px; --s-3:12px; --s-4:16px; --s-5:24px; --s-6:32px; --s-7:48px;

  /* rotunjire */
  --r-sm:5px; --r-md:9px; --r-lg:14px; --r-pill:999px;

  /* elevație */
  --e-1:0 1px 2px rgba(0,0,0,.35);
  --e-2:0 4px 14px rgba(0,0,0,.4);
  --e-3:0 16px 44px rgba(0,0,0,.55);

  --sans:-apple-system,"Segoe UI",Roboto,Inter,Helvetica,Arial,sans-serif;
  --mono:"Cascadia Code",ui-monospace,SFMono-Regular,Consolas,monospace;
  --sidebar-w:232px;
}

:root[data-theme="light"]{
  --bg-0:#F5F7FA; --bg-1:#FFFFFF; --bg-2:#FFFFFF; --bg-3:#F0F3F7; --bg-4:#E4EAF2;
  --border:#DDE3EB; --border-strong:#C3CCD9;
  --text-1:#101720; --text-2:#4C5866; --text-3:#78859A;
  --accent:#0B69D4; --accent-soft:rgba(11,105,212,.09);
  --ok:#12864C;   --ok-soft:rgba(18,134,76,.10);
  --warn:#9A6206; --warn-soft:rgba(154,98,6,.11);
  --bad:#C5372C;  --bad-soft:rgba(197,55,44,.10);
  --info:#5B45C9; --info-soft:rgba(91,69,201,.10);
  --unknown:#8894A6; --unknown-soft:rgba(136,148,166,.14);
  --e-1:0 1px 2px rgba(16,23,32,.06);
  --e-2:0 4px 14px rgba(16,23,32,.09);
  --e-3:0 16px 44px rgba(16,23,32,.16);
}
```

Culorile de accent din light mode sunt întunecate deliberat (`#12864C` în loc de `#3FD07F`)
ca să treacă contrastul AA pe fundal alb — nu sunt aceleași valori refolosite.
Toate cifrele folosesc `font-variant-numeric: tabular-nums`.

### 3.7 Stări: goală, încărcare, eroare, nemăsurat

Patru stări distincte pentru fiecare panou. Cea de-a patra este specifică acestei aplicații.

| Stare | Formă | Exemplu de copy |
|---|---|---|
| **Încărcare** | skeleton în forma conținutului real (nu spinner) | — |
| **Goală (bine)** | iconiță verde ✓ + explicație + acțiune | „Niciun link mort. Toate cele 50 de URL-uri au răspuns 200 OK. Ultima verificare azi, 14:17.” → *Extinde verificarea la 500* |
| **Goală (neutră)** | iconiță gri + ce lipsește + cum obții date | „Nicio verificare rulată încă. Apasă *Rescanează* pentru prima analiză.” |
| **Eroare** | iconiță roșie + endpoint + cauză + *Reîncearcă* | „`/api/occupations` a răspuns 500. Indexul COR nu a putut fi citit.” |
| **Nemăsurat** | `—` gri + eticheta „nemăsurat” + de ce | „Clasificarea locațiilor nu a rulat. Nu este 0 — nu a fost calculată.” |

Niciun text de tipul „sau câmpurile respective nu există în răspuns”. Dacă UI-ul nu știe,
spune ce nu știe și ce buton rezolvă.

**Acțiuni distructive** — scara de fricțiune din §2.5:

- `Golește indexul` iese din bara principală, cu tratament vizual de pericol;
- dialog care declară **raza de explozie exactă**: „Șterge toate cele 58.684 de joburi
  și 16.117 companii. Nu există coș de gunoi. Repopularea durează ~25 de minute.”;
- **type-to-confirm**: butonul rămâne dezactivat până se scrie `GOLEȘTE` (cu diacritică);
- focus implicit pe **Anulează**; `Esc` închide.

### 3.8 Asistentul AI

**Panou docat lateral, nu tab.** Un tab separat rupe contextul exact ca sub-pagina de la §3.3:
utilizatorul ar trebui să părăsească datele ca să întrebe despre ele. Docat, asistentul vede
ce vede utilizatorul — și poate răspunde la „ce e cu asta?” despre panoul curent.

- Se deschide din orice ecran (`?` sau butonul din sidebar), pe aceeași parte ca drawer-ul
  de drill-down, **excluzându-se reciproc cu acesta** (niciodată două panouri suprapuse).
- **Conștient de context:** știe ce ecran e deschis și ce regulă e selectată;
  sugestiile de start sunt legate de ecran („De ce pică verificarea CIF?”).
- **Tool-calls vizibile:** fiecare apel apare ca un rând compact — `⟳ interoghez /api/locations…`
  → `✓ 4.937 localități` — cu durată. Utilizatorul vede *pe ce date* se bazează răspunsul.
- **Răspunsurile citează** verificarea și expun aceeași afordanță `.drillable`:
  un număr dintr-un răspuns al asistentului deschide **același drawer**.
- **Domeniu strict declarat:** „consilier de ansamblu”. Răspunde despre agregate, tendințe,
  interpretare. Un banner permanent în panou: *„Răspund despre ansamblu. Nu procesez loturi
  și nu modific date.”* Nu primește unelte de scriere; orice mutație rămâne un buton
  explicit în UI, cu confirmarea de la §3.7.

### 3.9 Mobil

Sub 900px: sidebar-ul devine bară orizontală cu scroll, sub 560px: cardurile
comprimă padding-ul, ponderea și caretul se ascund, gălețile trec pe 2 coloane,
drawer-ul devine full-screen. Tabelele largi scrolează **în containerul lor**
(`overflow-x:auto`), niciodată pagina. Verificat: la 375px `scrollWidth === innerWidth`.

---

## 4. Prototipul

`public/prototype.html` — un singur fișier, HTML/CSS/JS vanilla, fără CDN, fără build.

**Demonstrează:** tokenii · sidebar + topbar · scorul cu 4 dimensiuni · lista de verificări
ordonată după impact, cu previzualizare de 3 rânduri la expandare · **drawer-ul de drill-down**
cu sortare, filtrare, paginare, export, acțiune pe rând și deep-link · gălețile de locații ·
diff-ul înainte→după · **patru grafice cu axe reale, în care fiecare element deschide
joburile din spatele lui** · stare goală „bine” · skeleton de încărcare · type-to-confirm ·
comutator de temă.

**Verificat în browser:**

| Verificare | Rezultat |
|---|---|
| Erori în consolă | niciuna |
| 1280×800 — overflow orizontal | absent (`scrollWidth 1265 ≤ 1280`) |
| Povestea completă în primul ecran | da — se termină la **507px** |
| 375×812 — overflow orizontal | absent (`375 === 375`) |
| Drawer pe mobil | full-screen, `left: 0`, 375px |
| Elemente drilabile pe pagină | **64**, un singur listener delegat |
| Drill din cifra unei verificări | „Anunțuri cu conținut pentru adulți” · 11 rânduri · 8 coloane |
| Drill din bară **Top localități** | `loc:Cluj-Napoca\|1363` → „Joburi în Cluj-Napoca”, toate rândurile în Cluj-Napoca |
| Drill din bară **Top companii** | `company:GEORGIANA SRL\|3150` → „Joburi publicate de GEORGIANA SRL” |
| Drill din bară **Acoperire** | `field:tags\|235` → „Joburi fără câmpul «tags»” · 235 rânduri |
| Drill din coloană **Salarii** | `band:3–4k\|101` → „Salarii în intervalul 3–4k RON” · 101 rânduri |
| Drill din segment **bară stivuită** | `loc_junk` → „Locații junk”, rânduri cu „Toată țara” |
| Paginare seturi mari | „Salariul lipsește” · `1–50 din 600 · eșantion din 58.154` · 12 pagini |
| Acțiune pe rând | „Acceptă normalizarea” · 50 butoane pe pagină |
| Sortare / filtrare / paginare | funcționale |
| Temă light | `#F5F7FA` / `#101720`, revine corect la dark |
| Type-to-confirm | `GOLESTE` blocat · `GOLEȘTE` acceptat |
| Diacritice pe disc | UTF-8 valid, ș/ț cu virgulă dedesubt |

Un bug real a fost găsit și reparat în timpul verificării: reveal-ul drawer-ului depindea de
`requestAnimationFrame`, care nu se execută când fila nu compune cadre — panoul rămânea
în afara ecranului. Înlocuit cu reflow forțat (`void el.offsetWidth`), plus o **garanție
a stării finale** (după 260ms se forțează `transform:none` dacă panoul e încă deschis)
și suport `prefers-reduced-motion`. Regula generală adoptată: **vizibilitatea unui panou
nu are voie să depindă de rularea unei animații.**

**Datele din prototip sunt realiste, dar sintetice** — orașe, firme și titluri românești
plauzibile. Cele 11 rânduri de conținut adult și cifrele agregate (58.684 / 16.117 / 4.735 /
9.731 / 530 / 12.839) sunt **reale**, luate din API-ul care rulează.

---

## 5. Ce urmează, în ordine

1. **Reparat cele două bug-uri de randare** (§1.1) — o oră de muncă, recuperează
   cardul de acoperire și elimină coloana de „?”. Independent de redesign.
2. **Registrul de reguli în backend**: `{cheie, nume, de_ce, severitate, pondere, q}` +
   endpoint `GET /api/rule/:cheie/rows?start=&rows=&sort=` — face drill-down-ul posibil peste tot.
3. **Endpoint scor** `GET /api/score` care întoarce scorul, dimensiunile și verificările,
   cu `nemăsurat` explicit.
4. **Shell-ul UI**: sidebar + topbar + tokeni.
5. **Drawer-ul de drill-down** — o dată, refolosit peste tot.
6. Ecranul Sănătate → Locații → restul secțiunilor.
7. Asistentul mutat în panou docat.
8. Traducerea sfaturilor în română + diacritice în `index.html`.

**Întrebări deschise pentru aprobare:**

- Ponderile din §3.2 — sunt corecte pentru echipă? (mai ales adult 20 vs ALL-CAPS 3)
- Clasificarea locațiilor întoarce 0 peste tot. Se repară backendul, sau gălețile
  se afișează ca „nemăsurat” până atunci?
- Acțiunile pe rând (accept normalizare, șterge job) scriu direct în Solr,
  sau se acumulează într-un lot care se aplică explicit la final?

---

## Surse

- [Qualytics — Quality Scores](https://userguide.qualytics.io/quality-scores/what-are-quality-scores/)
- [Collibra — The 6 Dimensions of Data Quality](https://www.collibra.com/blog/the-6-dimensions-of-data-quality)
- [iceDQ — 6 Data Quality Dimensions](https://icedq.com/6-data-quality-dimensions)
- [Soda vs. Great Expectations](https://www.dataexpert.io/blog/soda-vs-great-expectations-data-quality-tools)
- [Soda Data Quality Testing Guide](https://qaskills.sh/blog/soda-data-quality-testing-guide-2026)
- [Grafana — Dashboard best practices](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/)
- [Song & Szafir — Where's My Data? Evaluating Visualizations with Missing Data (IEEE VIS 2018)](https://cmci.colorado.edu/visualab/papers/song_VIS_2018.pdf)
- [SaaS Destructive Actions & Confirmation UX Patterns](https://www.saasui.design/blog/saas-destructive-actions-confirmation-ux-patterns)
- [NN/g — Confirmation Dialogs Can Prevent User Errors](https://www.nngroup.com/articles/confirmation-dialog/)
