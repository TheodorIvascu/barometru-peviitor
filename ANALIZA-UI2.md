# ANALIZA UI 2 — de ce interfața încă nu e OK

Analiză făcută pe instanța vie de la `http://localhost:7777`, pe **58.684 joburi**,
scor raportat **50/100**, `scannedAt = 2026-08-25T03:56:58Z`, 14 reguli măsurate din 14.

## Cum am verificat (și ce NU am putut verifica)

Screenshot-urile **nu funcționează** în acest mediu ("the Browser pane is not displayed,
so the page is not compositing frames"). Nu am văzut pagina cu ochii. Ca să nu inventez,
tot ce urmează e măsurat programatic în DOM-ul real, la 1280×800 și la 375×812:
`getBoundingClientRect()`, `getComputedStyle()`, `scrollHeight`, rapoarte de contrast
calculate din culorile computate (formula WCAG 2.1 relative luminance), numărători de
elemente, și răspunsurile brute de la API.

| Afirmație | Status |
|---|---|
| Geometrie (px, top, height, scrollWidth) | **măsurat** |
| Culori computate și contrast | **măsurat** |
| Ordinea de focus / tab stops | **măsurat** |
| Numere și reguli din API | **măsurat** (`/api/checks`, `/api/jobs`) |
| Aspectul vizual perceput (estetică, „cum arată") | **NEVERIFICAT** — fără screenshot |
| Comportamentul animațiilor / tranzițiilor | **NEVERIFICAT** — pagina nu compune cadre |

---

## 1. Diagnostic

### 1.1 BLOCANT — jumătate din grafica paginii nu se desenează deloc

Asta nu e „urât", e **rupt**. `app.js` scrie culori prin nume de variabile CSS care
**nu există** în `style.css`.

Măsurat, în DOM-ul viu:

```
--ok          → (UNDEFINED)     --good  există (#3fb950)
--blocant     → (UNDEFINED)     --bad   există (#f0685a)
--avertisment → (UNDEFINED)     --warn  există (#d9a63e)
--info        → (UNDEFINED)     --accent există (#3ba7ff)
--panel-2     → (UNDEFINED)
--dim         → (UNDEFINED)
```

Consecințe măsurate:

| Element | Ce ar trebui | Ce e computat efectiv |
|---|---|---|
| Arcul cadranului de scor | `stroke: var(--avertisment)` | **`stroke: none`** |
| Inelul de fundal al cadranului | `stroke: var(--panel-2)` | **`stroke: none`** |
| Segment „identificate" (58.256) | `background: var(--ok)` | **`rgba(0,0,0,0)`** |
| Segment „internaționale" (200) | `background: var(--info)` | **`rgba(0,0,0,0)`** |
| Segment „junk" (228) | `background: var(--blocant)` | **`rgba(0,0,0,0)`** |
| Cele 3 pastile din legendă | culoare per categorie | **toate `rgba(0,0,0,0)`** |

Deci: **cadranul de sănătate e un cerc gol cu „50" în mijloc**, iar cardul „Locații după
clasificare" e o **bandă goală cu chenar**, cu o legendă fără pastile colorate. Elementul
erou al primului ecran și singurul grafic de pe „Prezentare generală" nu redau nimic.

Cauza e regresie de rescriere: versiunea veche colora segmentele prin **clase**
(`.split-c0 { background: var(--good) }` … `style.css.old:272-277`), care funcționau.
Rescrierea le-a înlocuit cu `style.background = "var(--ok)"` inline și a inventat numele.

**Ironia care contează**: comentariul din capul lui `app.js` spune *„Rule #1 of this file:
NEVER guess a key name… The previous version guessed with pick(obj, [...]) and fell back to
0/[] when it guessed wrong."* Exact acel bug a fost reparat în JSON și **a supraviețuit
intact în CSS**. `var(--ok)` nedefinit nu dă eroare: cade silențios pe `unset`, adică
`stroke: none` / fundal transparent. Este aceeași clasă de defect — ghicire cu fallback
tăcut — doar mutată într-un alt strat. Nicio eroare în consolă, nicio urmă.

### 1.2 BLOCANT — scorul 50/100 măsoară aproape exact opusul a ce numește app-ul „blocant"

Formula (`lib/rules.js:315-325`):

```js
penalty += r.weight * (r.pct / 100);
maxPenalty += r.weight;
const s = Math.round(100 - (penalty / maxPenalty) * 100 * (maxPenalty / 20));
```

`maxPenalty` se simplifică algebric. Formula reală e:

```
scor = 100 − 5 × Σ(weight × pct/100)
```

`maxPenalty` e calculat și apoi anulat — cod mort care face formula să *pară*
normalizată când nu e. Verificat numeric pe datele vii: Σ = 10,0721 → 100 − 50,36 = **49,64
→ 50**. Se potrivește exact cu ce afișează UI-ul.

Descompunerea celor 50,36 puncte pierdute:

| Regulă | Severitate | Count | pct | Puncte pierdute | % din pierdere |
|---|---|---:|---:|---:|---:|
| `loc_needs_fix` | avertisment | 55.873 | 95,21 | **28,56** | **56,7%** |
| `dup_title_company` | avertisment | 24.651 | 42,01 | **16,80** | **33,4%** |
| `title_allcaps` | **cosmetic** | 9.701 | 16,53 | 2,48 | 4,9% |
| `company_html_entity` | avertisment | 3.742 | 6,38 | 1,60 | 3,2% |
| `loc_country` | info | 1.975 | 3,37 | 0,34 | 0,7% |
| toate celelalte | — | — | — | 0,58 | 1,2% |
| **din care TOATE cele 5 reguli „blocant"** | blocant | **293** | — | **0,31** | **0,6%** |

Două reguli de normalizare fac **90,1%** din pierderea de scor. Toate cele cinci reguli pe
care aplicația le pictează roșu și le numește *blocante* — locații fără sens (228), joburi
fără companie (19), CIF invalid (6), conținut adult (38), titluri inutilizabile (2) —
însumează **293 de joburi = 0,5% din index** și mișcă scorul cu **0,31 puncte**.

Regula „cosmetic", despre care `rules.js` scrie explicit în comentariu că *„weight 3 or less
… cannot meaningfully move the number"*, mișcă scorul de **8 ori mai mult decât toate
regulile blocante la un loc** (2,48 vs 0,31). Intenția declarată a design-ului e
contrazisă de aritmetică.

Mai grav pentru încredere: **scorul nu e normalizat**, deci scade mecanic când adaugi
reguli. O regulă nouă cu weight 1 care atinge 100% costă 5 puncte, indiferent de restul
registrului. Adică *scorul se înrăutățește pe măsură ce tool-ul devine mai bun la
detectat*. Un număr care scade când îmbunătățești instrumentul nu poate ghida nicio decizie.

Ce citește proprietarul: „baza mea de date e pe jumătate stricată". Ce e adevărat: 99,5%
din rânduri n-au nicio problemă blocantă, iar 95% au nevoie de o normalizare de locație
care e **automatizabilă într-o singură trecere**. Sunt două mesaje complet diferite.

### 1.3 BLOCANT — ierarhia vizuală clasează după mărime, nu după importanță

`app.js` sortează în interiorul fiecărei grupe cu
`g.items.sort((a,b) => (b.count||0) - (a.count||0))` — pur descrescător după count.
Severitatea nu intră deloc în sortare.

Ordinea reală în DOM, măsurată, cu poziția verticală absolută:

| # | y (px) | Severitate | Regulă | Count |
|---:|---:|---|---|---:|
| 1 | 705 | avertisment | Locații de corectat | 55.873 |
| 2 | 769 | info | Locații doar la nivel de țară | 1.975 |
| 3 | 834 | **blocant** | Locații care nu sunt locuri | 228 |
| 4 | 898 | avertisment | Locații din afara României | 200 |
| 5 | 1035 | avertisment | Nume companie cu HTML nedecodat | 3.742 |
| 6 | 1100 | **blocant** | Joburi fără companie în catalog | 19 |
| 7 | 1164 | **blocant** | CIF invalid | 6 |
| 8 | 1301 | avertisment | Joburi duplicate | 24.651 |
| 9 | 1366 | cosmetic | Titluri cu majuscule | 9.701 |
| 10 | 1430 | avertisment | Telefon sau email în titlu | 44 |
| 11 | 1494 | **blocant** | Conținut pentru adulți | 38 |
| 12 | 1558 | **blocant** | Titluri inutilizabile | 2 |
| 13 | 1696 | info | Fără mod de lucru | 241 |
| 14 | 1760 | info | Fără etichete | 236 |

**Zero din cele 5 reguli blocante sunt deasupra pliului de 800px.** Media lor: y = 1030px.
Cea mai gravă ca tip de conținut — „Conținut pentru adulți", singura cu risc reputațional
și legal real pentru un job board — e pe poziția **11 din 14**, la **1494px**, adică la
aproape două ecrane de scroll. Iar „Titluri inutilizabile" e ultima din grupa ei, la 1558px,
**doar pentru că numărul ei e 2**.

Regula devine: *cu cât o problemă e mai rară, cu atât e îngropată mai adânc* — exact
invers față de cum funcționează triajul. Raritatea e adesea semnalul că ceva e grav și
reparabil acum.

### 1.4 Severitatea e codificată în 0,087% din suprafața rândului

Măsurat pe toate cele 14 rânduri:

- singurul purtător de severitate e `.dot`, **8×8 px = 64 px²**;
- rândul are **1144×64 px = 73.216 px²**;
- deci severitatea ocupă **64 / 73.216 = 0,087%** din rând.

Tot restul e **identic** pentru toate cele 14 rânduri, verificat prin `getComputedStyle`:

| Proprietate | blocant (CIF invalid, 6) | cosmetic (Majuscule, 9.701) |
|---|---|---|
| Culoare count | `rgb(230,237,243)` | `rgb(230,237,243)` — identică |
| Font-size count | `16px` | `16px` — identic |
| Culoare label | `rgb(230,237,243)` | `rgb(230,237,243)` — identică |
| Font-size label | `14px` | `14px` — identic |
| Fundal rând | transparent | transparent |
| Bordură | `1px solid transparent` | `1px solid transparent` |

Un rând blocant și unul cosmetic sunt **tipografic imposibil de distins**. Singura diferență
e un punct de 8px pe care trebuie să-l cauți activ și al cărui cod de culoare trebuie
memorat, pentru că **nu există legendă nicăieri în pagină**.

În plus, numărul mare câștigă mereu vizual: `55.873` și `24.651` sunt șiruri lungi în
font mono la 16px, iar `6` și `2` sunt un singur caracter. **Cifra importantă e literalmente
cea mai mică pată de cerneală de pe ecran.** Nimic nu compensează asta.

### 1.5 Primul ecran nu răspunde la întrebarea utilizatorului

Măsurat la 1280×800, poziții absolute:

| Element | top (px) | înălțime |
|---|---:|---:|
| topbar | 0 | 55 |
| tab bar | 55 | 43 |
| titlu panou | 116 | 28 |
| card Scor (cadran gol) | 158 | 183 |
| card Totaluri index | 355 | 168 |
| card Locații după clasificare (bandă goală) | 538 | 110 |
| **primul rând de problemă acționabilă** | **705** | 64 |
| pliu 800px | — | — |

**705 px de pixeli înainte de primul element acționabil.** Din cei 800px vizibili, primul
rând de problemă apare pe ultimii 95px, tăiat. Ce ocupă acei 705px: un cadran care nu se
desenează, patru numere mari din care două sunt totaluri sănătoase, și un grafic invizibil.

Deasupra pliului am numărat **17 tokenuri numerice** care concurează pentru atenție.
Ierarhia lor de mărime:

- `50` — 30px (scorul, cel mai puțin acționabil număr de pe ecran)
- `58.684` — 26px (total joburi, o informație **neutră**)
- `56.281` — 26px (locații identificate, o informație **bună**)
- `228` — 26px (junk, **blocant**)
- `38` — 26px (adult, **blocant**)

Cele două numere blocante sunt redate **exact la fel** ca totalul index și ca numărul de
locații corecte. Nimic nu spune ochiului că două dintre ele cer acțiune și două nu.

Întrebarea reală a proprietarului e *„ce e stricat și ce fac cu asta acum?"*.
Primul ecran răspunde la *„câte lucruri am numărat?"*. E un raport, nu o listă de lucru.

### 1.6 14 reguli în listă plată = perete nediferențiat

Cele 14 reguli sunt împărțite în 4 grupe (Locații 4, Companii 3, Titluri 5,
Completitudine 2), dar grupele sunt **taxonomice — după câmpul atins — nu după ce trebuie
făcut**. Un utilizator care vrea să repare ceva nu se întreabă „ce probleme de titlu am?",
ci „ce pot rezolva automat, ce trebuie să citesc, ce trebuie doar să știu".

Măsurat: pagina are **1871px scrollHeight**, 7 carduri, 7 titluri `h3`, 14 rânduri de reguli
și **20 de elemente `role="button"`** — toate cu aceeași greutate vizuală. Nu există niciun
mecanism de reducere: nimic nu e pliat, nimic nu e ascuns, nimic nu e marcat „rezolvat"
sau „acceptat". Cele 14 reguli sunt mereu toate acolo, la aceeași dimensiune, în aceeași
ordine, indiferent de starea bazei.

Consecință: nu există **progres**. Dacă repari „Locații care nu sunt locuri" de la 228 la 0,
rândul rămâne pe ecran cu `opacity: .55` — al treilea din listă, ocupând același spațiu.
Munca făcută nu se vede nicăieri.

### 1.7 Sertarul arată rândurile, dar nu explică de ce sunt marcate

Măsurat cu sertarul deschis pe `loc_junk` (228 rânduri):

- coloane: **Titlu, Companie, Locație, Detaliu** — 4, fixe, neconfigurabile;
- **0 antete sortabile** (`#dbody th button` → 0);
- **0 acțiuni pe rând** (`#dbody tbody button` → 0);
- paginare: 50/pagină, doar `‹ înapoi` / `înainte ›`. Pentru `dup_title_company` (24.651)
  înseamnă **494 de pagini** accesibile doar din aproape în aproape;
- coloana „Detaliu" conținea **`not-a-place` pe toate cele 10 rânduri inspectate** — un enum
  intern, în engleză, netradus, identic peste tot, deci **cu zero informație per rând**.

Singura explicație reală e ascunsă în coloana „Locație", care afișează
`all, Romania → (neidentificat)`. Săgeata nu e explicată nicăieri. Utilizatorul vede o
transformare fără să afle că `all` e valoarea respinsă, `→` înseamnă „forma canonică" și
`(neidentificat)` înseamnă „n-am putut deduce nimic".

Și un defect funcțional: `drawer.csv()` construiește CSV-ul din `this.rows`, adică
**doar pagina curentă**. Apeși „export CSV" pe o regulă cu 24.651 rânduri și primești
**50**, fără niciun avertisment. Asta reintroduce exact problema de încredere pe care
proprietarul a mai avut-o: numărul de pe ecran și fișierul exportat nu sunt de acord.

### 1.8 Accesibilitate — sertarul închis fură focusul, tab-urile mint

Măsurat: **34 de elemente focusabile**, din care **20 sunt `role="button"` pe `div`/`span`**.

**Sertarul închis rămâne în ordinea de tab.** E mutat cu `transform: translateX(940px)`, dar:
`visibility: visible`, **fără `inert`**, **fără `aria-hidden`**, `focusableInside: 4`.
Un utilizator de tastatură care trece de ultimul rând de regulă (stop 29) aterizează pe
**stopurile 30–33 într-un sertar invizibil**: „export CSV", „închide", „‹ înapoi",
„înainte ›". Nu are cum să știe unde e.

**Niciun focus trap.** Cu sertarul deschis, verificat: focusul rămâne pe rândul din fundal
(`focusIsInsideDrawer: false`), toate cele **14 rânduri din fundal rămân focusabile**,
`body` are `overflow: visible` (fundalul se derulează în spate), iar `<aside>` **nu are
`role="dialog"` și nici `aria-modal`**. Nu există nici mutare de focus la deschidere, nici
restaurare la închidere.

**Pattern-ul ARIA de tab-uri e rupt și înșelător.** `role="tablist"` + 5 × `role="tab"`, dar
`aria-selected` este **`null` pe toate cinci**, și **nu există niciun `role="tabpanel"`**
în pagină. Un cititor de ecran anunță „tab" dar nu poate spune niciodată care e selectat —
mai rău decât dacă nu ar exista ARIA deloc. Lipsește și navigarea cu săgeți: cele 5 tab-uri
sunt 5 stopuri separate în loc de unul.

Alte constatări măsurate:

- **Fără `<h1>`.** Structura începe direct la `h2`. Există un `h3` cu textul `—` (titlul
  sertarului închis), anunțat ca titlu gol.
- **Focus vizibil doar pe 2 din 20** de elemente `role="button"`: CSS-ul conține exact
  `.rule:focus-visible` și `.bar:focus-visible`. Cele 2 carduri `.stat.clickable`, cele 2
  segmente de bandă și cele 2 pastile de legendă nu au stil propriu de focus (rămân pe
  inelul implicit al browserului, slab pe fundal închis).
- **Stopuri duplicate pentru aceeași acțiune**: `aria-label="internaționale: 200 joburi"`
  apare de **2 ori** (segmentul + pastila de legendă), la fel `"junk: 228 joburi"`.
- **15 stopuri de tab** înainte de primul rând de problemă.
- **Ținte de atins sub minim**: segmentele „internaționale" și „junk" măsoară
  **4×20 px** la 1280px. WCAG 2.2 cere minim 24×24. Sunt sub o șesime din suprafața minimă,
  și sunt singura cale grafică spre o problemă blocantă.

### 1.9 Contrast — tot textul explicativ pică AA

`--text-faint: #6b7a8c` pe `--bg-panel: #161d27` dă **3,86:1**. WCAG 2.1 AA cere 4,5:1
pentru text normal. Roluri afectate, toate măsurate:

| Rol | Mărime | Contrast | AA |
|---|---:|---:|:--:|
| `.rule .hint` (explicația fiecărei reguli) | 12px | **3,86** | ✗ |
| `.rule .pct` | 11px | **3,86** | ✗ |
| `.card > h3` (titlul fiecărui card) | 11px | **3,86** | ✗ |
| `.dial .mid span` („DIN 100") | 10px | **3,86** | ✗ |
| `.stat-sub` („blocant", „95.9% din total") | 11px | **3,99** | ✗ |
| `.brand-sub` | 11px | **3,99** | ✗ |
| `.freshness` | 11px | **3,99** | ✗ |
| `.panel-status` | 11px | **4,31** | ✗ |
| `.rule .label` | 14px | 14,34 | ✓ |
| `.stat-label` | 11px | 7,87 | ✓ |

Cade exact stratul care **explică**: fiecare `hint` de regulă, fiecare titlu de card, și
eticheta `blocant` de sub numerele mari. Textul care spune *ce înseamnă* un număr e cel mai
greu de citit din pagină. Titlurile de card la 11px uppercase cu 3,86:1 sunt cea mai slabă
combinație posibilă — mic, spațiat, și sub prag.

### 1.10 La 375px aplicația devine inutilizabilă

Măsurat la 375×812 după reîncărcare:

| Măsurătoare | Valoare |
|---|---|
| Înălțime totală pagină | **2853px** = 3,5 ecrane |
| **Primul rând de problemă** | **y = 1339px** = 1,65 ecrane de scroll |
| Înălțime topbar | **137px** (se rupe pe 3 rânduri) = **16,9% din viewport** |
| Înălțime card scor | **338px** = **41,6% din viewport** |
| Tab bar | `scrollWidth 520` vs `clientWidth 375` → **tăiat** |
| Segment „internaționale" | **1,03 × 21 px** |
| Segment „junk" | **1,18 × 21 px** |
| Overflow orizontal pagină | nu (corect) |

Trei lucruri ies în evidență:

1. **1339px până la prima problemă.** Primele 1,65 ecrane sunt: bara de acțiuni
   distructive, un cadran gol care ocupă 41,6% din ecran, și patru numere stivuite.
2. **Butonul „✕ golire" — ștergerea completă a indexului — e deasupra pliului, la
   dimensiune plină**, în timp ce prima problemă reală e la 1339px. Acțiunea cea mai
   periculoasă e cea mai accesibilă.
3. **Ținte de 1px.** Segmentele „junk" (228, blocant) și „internaționale" (200) au
   **1,03px și 1,18px lățime**. Pe touch e imposibil de atins — și oricum sunt invizibile
   (§1.1). Tab-urile „Ocupații (COR)" și „Asistent" sunt în afara ecranului fără nicio
   indicație de derulare (doar `overflow-x: auto`, fără gradient sau săgeată).

### 1.11 Registrul servit nu e cel de pe disc

`lib/rules.js` de pe disc definește **15** reguli, inclusiv `title_adult_confirmed`
(tier `judge`, severitate blocant, weight 20). API-ul viu întoarce **14** reguli, iar
`title_adult` apare cu `severity: blocant, weight: 20` — adică serverul rulează o versiune
mai veche, încărcată în cache-ul de module Node la pornire. Orice specificație trebuie
scrisă pe contractul API, nu pe fișierul de pe disc, și serverul trebuie repornit după
editarea registrului. (Măsurat prin comparație între `/api/checks` și sursă.)

---

## 2. Cercetare — ce fac instrumentele mature

Am studiat modul în care sunt prezentate rezultatele bazate pe reguli și drill-down-ul în:
**Sentry** (issue stream), **Linear** (triage inbox), **GitHub** (Dependabot / code scanning
alerts), **dbt** (`dbt test` + elementary report), **Great Expectations** (Data Docs
validation results), **Soda Cloud**, **Monte Carlo**, **Datadog** (monitors list).

Sentry și Linear sunt cele mai relevante: amândouă rezolvă exact forma acestei aplicații —
*o listă lungă de probleme, clasate, fiecare deschizându-se în dovezi*.

### 2.1 Sentry — issue stream

- **Rândul e o problemă, nu o apariție.** 24.651 de duplicate nu sunt 24.651 de rânduri;
  sunt **un** rând cu un contor. Aplicația noastră face deja asta corect — dar apoi
  clasează după acel contor, ceea ce Sentry nu face.
- **Contorul nu e clasamentul.** Sortarea implicită e „Last Seen" / „Trends", nu „Events".
  Un crash cu 3 apariții pe un endpoint de plată urcă peste unul cu 40.000 de apariții
  într-un logger. **Volumul e un atribut, nu o prioritate.**
- **Numerele mari sunt comprimate tipografic**: `24.7k`, nu `24,651`, la dimensiune mică,
  într-o coloană îngustă fixă, la dreapta. Un număr scurt nu poate domina vizual un titlu.
- **Sparkline lângă contor**: forma în timp contează mai mult decât mărimea. „În creștere"
  e mai acționabil decât „mare".
- **Stări de ciclu de viață**: Unresolved / Resolved / Ignored / Archived. O problemă
  acceptată **dispare din listă** — asta e mecanismul care ține lista scurtă pe măsură ce
  produsul crește.
- **Nivelul e o bandă colorată pe muchia din stânga a rândului**, plus text, nu un punct.

### 2.2 Linear — triage inbox

- **Triajul e o coadă cu o singură decizie per element**: Accept / Decline / Snooze /
  Duplicate. Nu „uite datele", ci „ce faci cu asta".
- **Layout în două panouri**: lista la stânga, detaliul elementului selectat la dreapta,
  **permanent**, nu într-un sertar care acoperă contextul. Poți parcurge cu `J`/`K` și
  detaliul se schimbă — 20 de elemente în 20 de apăsări, fără deschis/închis.
- **Prioritatea e explicită și separată de volum**: Urgent / High / Medium / Low / No
  priority, cu iconițe distincte ca **formă**, nu doar culoare.
- **Tot e accesibil de la tastatură**, iar scurtăturile sunt afișate în UI.

### 2.3 GitHub — security / Dependabot alerts

- **Antet cu numărătoare pe severitate ca filtre**: `5 Critical  12 High  3 Moderate`.
  Sunt și rezumat, și control. Vezi distribuția înainte de listă.
- **Fiecare alertă spune de ce e a ta**: fișierul, linia, lanțul de dependențe. Dovada
  e în rând, nu la două click-uri.
- **„Dismiss" cere un motiv** dintr-o listă închisă (fals pozitiv / risc acceptabil / nu
  se folosește). Excluderea e o decizie înregistrată, nu o dispariție.

### 2.4 dbt / Elementary / Great Expectations

- **dbt**: rezultatul unui test e `pass / fail / warn / error`, iar fail-ul vine cu
  `store_failures` — un tabel cu **exact rândurile care au picat**. Numărul și rândurile
  sunt același obiect. Aplicația noastră face deja asta (aceeași interogare pentru count și
  rânduri) și e cel mai bun lucru din ea.
- **dbt separă `severity: warn` de `severity: error`**: doar `error` rupe build-ul.
  Există un prag explicit între „știu" și „opresc".
- **Great Expectations Data Docs**: fiecare expectation arată
  `observed_value` vs `expected_value` **lângă** rezultat, plus `unexpected_percent` și un
  eșantion de `unexpected_values`. Nu vezi doar „a picat", ci **ce a văzut și ce aștepta**.
- **GE afișează un „success rate" per suită**, dar niciodată un singur scor global peste
  suite eterogene — pentru că nu ar însemna nimic. Lecție directă pentru §1.2.
- **Elementary** grupează după **tabel și coloană**, adică după **unde repari**, nu după
  tipul de test.

### 2.5 Soda Cloud / Monte Carlo / Datadog

- **Soda**: fiecare check are un **owner** și un **dataset**; incidentele se grupează pe
  dataset. Sănătatea e per-obiect, nu per-organizație.
- **Monte Carlo**: separă **anomalii detectate automat** de **reguli scrise de om**, și
  arată explicit „ce s-a schimbat față de linia de bază". Delta, nu absolutul.
- **Datadog monitors**: stările sunt `Alert / Warn / No Data / OK`. **`No Data` e o stare
  de primă clasă** — distinctă de „e bine". Aplicația noastră are deja conceptul
  („nemăsurat") dar îl redă ca text gri în aceeași casetă ca un count real.

### 2.6 Tipare transferabile (concret)

| # | Tipar | Sursă | Aplicare aici |
|---|---|---|---|
| T1 | Volumul e atribut, nu clasament | Sentry, Linear | Sortare pe severitate, apoi impact; count-ul e o coloană îngustă |
| T2 | Numerele mari se comprimă (`24,7k`) | Sentry | `55.873` nu mai poate strivi `6` |
| T3 | Numărători pe severitate în antet, ca filtre | GitHub | Bandă de triaj în primii 400px |
| T4 | Bandă de severitate pe muchie + formă, nu doar punct | Sentry, Linear | Înlocuiește punctul de 8px |
| T5 | Ciclu de viață: rezolvat/acceptat dispare din listă | Sentry, GitHub | Rezolvă „nu există progres" (§1.6) |
| T6 | Excluderea cere un motiv înregistrat | GitHub | Se leagă de override-ul uman peste AI |
| T7 | `observed` vs `expected` în rând | Great Expectations | Coloana „de ce" din sertar |
| T8 | Grupare după *unde repari*, nu după tipul regulii | Elementary | Regrupare în „automat / de citit / de știut" |
| T9 | Listă + detaliu persistent, navigabil cu `J`/`K` | Linear | Alternativă la sertarul modal |
| T10 | `No Data` e stare distinctă de `OK` | Datadog | „nemăsurat" ≠ „0" |
| T11 | Fără scor global peste suite eterogene | Great Expectations | Vezi §3.2 |

---
