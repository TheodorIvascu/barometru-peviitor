# SOLR DOCTOR — definiție de produs

**Data:** 25 august 2026
**Metodă:** fiecare cifră din acest document a fost măsurată direct pe indexul local
(`job` = 58.684 docs, `company` = 16.117 docs), prin scanare completă cu `cursorMark`.
Scripturile de măsurare sunt în scratchpad-ul sesiunii (`concentration.js`, `join.js`, `fresh.js`).
Unde cifra din brief diferă de măsurătoare, este marcat explicit.

---

## 0. Rezumat executiv

Trei constatări schimbă produsul:

1. **Defectele reale nu sunt distribuite — sunt lipite de câte o sursă.**
   Măsurate ca *rată în interiorul sursei raportată la media indexului* („lift"),
   defectele adevărate au un lift între **4x și 257x** pe o sursă nominalizabilă.
   Regulile cu lift ≈ 1 (uniforme peste toate sursele) **nu sunt defecte** —
   sunt goluri de schemă sau output-ul propriului normalizator.

2. **Orice reparație scrisă pe un rând este ștearsă în câteva zile.**
   Toate cele 58.684 de documente au `date` între **2026-08-21 și 2026-08-24** —
   patru zile. Indexul are `maxDoc` 78.191 și `deletedDocs` 19.507. Indexul se
   rescrie integral la fiecare ciclu de scraping. **Un „workbench de corectat date"
   este structural imposibil aici.** Singura reparație care persistă este în scraper.

3. **Unitatea de mentenanță există deja în date și nu e folosită.**
   Core-ul `company` are câmpul `scraperFile`, care pentru 64 de companii conține
   URL-ul real al repo-ului GitHub al scraperului. **19 din cele 64 (30%) produc
   ZERO joburi.** Asta e literalmente lista „ce scraper e stricat săptămâna asta",
   iar tooling-ul de azi nu o calculează.

**Cea mai mare schimbare:** ecranul principal nu trebuie să fie un scor 50/100 și o
listă de reguli, ci **un scorecard pe sursă** ordonat după `lift × volum`, cu
repo-ul GitHub responsabil pe fiecare rând.

---

## 1. Utilizatorul principal și decizia pe care o ia

### Candidați evaluați

| Utilizator | Decizia lui | Poate acționa? | Verdict |
|---|---|---|---|
| Mentenorul peviitor | „ce scraper repar în cele 2 ore de sâmbătă" | **Da** — controlează repo-urile | **PRIMAR** |
| Contribuitorul care triază date | „marchez rândul ăsta ca greșit" | Nu — scrierea e ștearsă în 3 zile | Secundar, degradat |
| Vizitatorul peviitor.ro | „raportez anunțul ăsta" | Nu — nu are acces la tool | Nu e utilizator al acestui tool |

### Justificare

Motivul nu e preferință, e o constrângere fizică a sistemului, verificată:

```
stats.field=date  →  min 2026-08-21T08:38:58Z   max 2026-08-24T09:19:18Z
maxDoc 78.191  |  numDocs 58.684  |  deletedDocs 19.507
```

Nu există niciun document mai vechi de patru zile. Indexul nu e o bază de date pe
care o îngrijești — e un **buffer de ieșire al unui pipeline de scraping**. Orice
corecție pe un rând (rescrierea unui `location`, decodarea unui `&amp;`) trăiește
până la următoarea rulare a scraperului care a produs rândul. Prin urmare:

> Singurul utilizator care poate face o schimbare care **persistă** este cel care
> poate modifica un scraper. Toți ceilalți pot cel mult produce muncă ce se auto-anulează.

### Ce trebuie să-i spună tool-ul

Nu „ai 55.873 de probleme". Un voluntar cu două ore pe săptămână are nevoie de:

> **„Repară `iajob.ro`. Produce 16,8% din index și 69% din toate numele de companie
> stricate. 26,3% din joburile lui au `&amp;` nedecodat, față de 6,4% media indexului
> — lift 4,1x. Aici sunt 20 de rânduri ca dovadă."**

Trei propoziții, un nume, un număr comparativ, o dovadă. Asta e produsul.

---

## 2. Job-to-be-done — o singură propoziție

> **SOLR DOCTOR îi spune mentenorului peviitor care sursă s-a stricat, cât de rău,
> și cine o deține — ordonat astfel încât primul rând reparat să scoată cele mai
> multe rânduri proaste din index.**

### Forma produsului: *scraper scorecard cu alarmă de regresie*

Argument pentru, și costul celorlalte forme:

| Formă | Cost / de ce nu |
|---|---|
| **Scraper scorecard** (ales) | Corespunde unității reale de reparație (repo GitHub). Funcționează cu datele existente azi. |
| Monitoring dashboard | Presupune serie temporală. **Nu există istoric** — nici în Solr (4 zile), nici în tool. Devine posibil doar după ce tool-ul își scrie propriile snapshot-uri. Este *faza 2 a scorecard-ului*, nu o alternativă. |
| Triage queue per-job | Costă timp de voluntar pe muncă ștearsă la următorul scrape. 24.651 de duplicate nu se triază manual niciodată. **De respins.** |
| Data-fixing workbench | Structural imposibil: scrierile sunt suprascrise (vezi §0.2). Ar da iluzia de progres. **De respins.** |
| Release gate | Presupune un deploy discret de gate-uit. peviitor face ingest continuu, nu release-uri. Nu există momentul în care gate-ul s-ar aplica. **De respins**, cu o excepție: un gate *per-sursă* la ingest (refuză lotul dacă rata de defect a sursei sare peste prag) — e valoros, dar e o funcție a pipeline-ului peviitor, nu a acestui tool. |

---

## 3. Analiza de concentrare — cifrele reale

### 3.1 Volumul în sine e concentrat (deci procentele brute mint)

392 de domenii înregistrabile, 470 de host-uri distincte, extrase din `url`.

| Domeniu | Joburi | % din index | Companii distincte |
|---|---:|---:|---:|
| iajob.ro | 9.877 | 16,8% | 116 |
| anofm.ro | 8.026 | 13,7% | 3.247 |
| bestjobs.eu | 6.920 | 11,8% | 5.406 |
| jobviewtrack.com | 6.259 | 10,7% | 1.390 |
| multijobs.ro | 4.379 | 7,5% | 838 |
| oferimdemunca.ro | 3.348 | 5,7% | 190 |
| hipo.ro | 2.154 | 3,7% | 117 |
| ejobs.ro | 1.475 | 2,5% | 686 |
| undelucram.ro | 1.372 | 2,3% | 66 |
| jobradar24.ro | 1.292 | 2,2% | 366 |

**Top 3 = 42,3% din index. Top 5 = 60,4%. Top 10 = 76,9%. Top 30 = 89,5%.**

Aici e capcana metodologică: dacă o sursă are 16,8% din index, e de așteptat să aibă
~16,8% din orice defect uniform. **Concentrarea trebuie măsurată ca lift**, nu ca
cotă brută:

```
lift = (rata defectului în sursă) / (rata defectului în tot indexul)
```

### 3.2 Concentrarea per regulă (măsurată, nu estimată)

| Regulă | Total | Domenii atinse | Top-1 domeniu | cota top-1 | top-3 | top-5 |
|---|---:|---:|---|---:|---:|---:|
| `loc_junk` | 228 | 24 | globallogic.com (50) | 21,9% | **46,1%** | 61,4% |
| `loc_country` | 1.975 | 46 | bestjobs.eu (717) | 36,3% | 64,5% | 74,4% |
| `loc_international` | 200 | 10 | bestjobs.eu (100) | 50,0% | **82,5%** | 91,5% |
| `loc_needs_fix` | 55.873 | 364 | iajob.ro (9.868) | 17,7% | 43,2% | 61,9% |
| `cif_orphan` | 19 | **1** | arrise.com (19) | **100%** | 100% | 100% |
| `cif_bad_checksum` | 6 | 3 | bestjobs.eu (4) | 66,7% | 100% | 100% |
| `company_html_entity` | 3.742 | 33 | iajob.ro (2.593) | 69,3% | **87,2%** | 91,2% |
| `title_html_entity` *(nouă)* | 1.890 | 147 | jobviewtrack.com (447) | 23,7% | 51,3% | 59,8% |
| `title_adult` | 38 | 4 | bestjobs.eu (27) | 71,1% | **97,4%** | 100% |
| `title_contact` | 44 | 12 | publi24.ro (12) | 27,3% | 56,8% | 79,5% |
| `title_too_short` | 2 | 2 | bestjobs.eu (1) | 50% | 100% | 100% |
| `title_allcaps` | 9.701 | 56 | anofm.ro (7.675) | **79,1%** | 91,9% | 95,1% |
| `dup_title_company` | 24.651 | 170 | iajob.ro (7.500) | 30,4% | **65,8%** | 74,5% |
| `missing_workmode` | 241 | 9 | tremend.com (100) | 41,5% | 88,0% | 95,9% |
| `missing_tags` | 236 | 22 | applytojob.com (85) | 36,0% | 55,9% | 69,1% |

**Răspuns direct la întrebarea din brief:**

- din **228** locații junk → **46,1%** vin din top-3 domenii (globallogic.com, luxoft.com, deloittece.com — toate trei ATS-uri corporate, nu job board-uri);
- din **24.651** duplicate → **65,8%** din top-3 (iajob.ro, jobviewtrack.com, anofm.ro);
- din **3.742** nume de companie cu entități HTML → **87,2%** din top-3, și **69,3% dintr-un singur domeniu** (iajob.ro);
- din **38** joburi adult → **97,4%** din top-3 (bestjobs.eu 27, publi24.ro 6, iajob.ro 4). Ipoteza din brief se confirmă exact.

### 3.3 Lift-ul — cifra care contează de fapt

| Regulă | Sursa dominantă | Rata în sursă | Media indexului | **Lift** | Interpretare |
|---|---|---:|---:|---:|---|
| `missing_workmode` | tremend.com (100/115) | 87,0% | 0,41% | **212x** | bug de mapping într-un scraper |
| `loc_junk` | makitajobs.ro (18/18) | 100% | 0,39% | **257x** | scraper complet stricat pe locație |
| `loc_junk` | globallogic.com (50/73) | 68,5% | 0,39% | **176x** | idem |
| `missing_tags` | applytojob.com (85/87) | 97,7% | 0,40% | **243x** | idem |
| `loc_country` | keysight.com (83/91) | 91,2% | 3,37% | **27x** | scraperul nu extrage orașul |
| `title_adult` | bestjobs.eu (27/6.920) | 0,39% | 0,065% | **6,0x** | politică de conținut a sursei |
| `title_allcaps` | anofm.ro (7.675/8.026) | 95,6% | 16,53% | **5,8x** | convenție a bazei ANOFM |
| `company_html_entity` | iajob.ro (2.593/9.877) | 26,3% | 6,38% | **4,1x** | decode HTML lipsă |
| `dup_title_company` | jobviewtrack.com (5.501/6.259) | 87,9% | 42,0% | **2,1x** | re-ingest / agregator de agregatoare |
| `loc_needs_fix` | iajob.ro (9.868/9.877) | 99,9% | 95,2% | **1,05x** | **nu e defect** — vezi §3.4 |
| `no_expiration` | oricare | 100% | 100% | **1,00x** | **nu e defect** — gol de schemă |

**Concluzia analizei:** ipoteza din brief este **confirmată, dar cu o corecție importantă**.
Nu „80% din gunoi vine din 3 surse" — asta e adevărat doar pentru unele reguli.
Adevărul mai util este:

> **Un defect real are lift ≥ 4x pe o sursă nominalizabilă. O regulă cu lift ≈ 1
> nu măsoară un defect, ci o proprietate a întregului sistem.**

Iar asta e criteriul de sortare al ecranului principal și, în același timp,
criteriul de tăiere din §6.

### 3.4 Cea mai mare cifră de pe ecran măsoară... normalizatorul

`loc_needs_fix` = **55.873 (95,21%)** este numărul cel mai mare din tool. Măsurat pe surse:
iajob.ro 99,9%, anofm.ro 100%, multijobs.ro 100%, oferimdemunca.ro 100%, jobviewtrack.com 99,5%.
Lift 1,05x. O regulă care se aprinde pe ~100% din fiecare sursă majoră nu distinge nimic.

Cauza, din cod: `classify.js` — acest tool scrie el însuși `location_s`, `loc_kind`,
`loc_how`, iar comentariul din fișier o spune explicit: *„The original `location` is
left alone on purpose"*. Deci `loc_needs_fix` compară intrarea brută cu propriul output
canonic. **Nu numără probleme; numără de câte ori normalizatorul a avut ceva de făcut.**
Este un contor de „writeback în așteptare", nu un contor de defecte.

### 3.5 Defecte reale pe care tool-ul NU le vede azi

Descoperite în timpul acestei analize, toate verificate:

| Constatare | Cifră măsurată | De ce contează |
|---|---:|---|
| **Scrapere dedicate care produc ZERO joburi** | **19 din 64 (30%)** | Lista directă „ce e stricat". Nume reale: Bitdefender, Garmin Cluj, Stefanini, Assist Software, Wolfpack Digital, Connatix, Yardi, Rapel, Mejix, Wayfare, Vel Pitar, Utilben, Ulma Packaging, Cybertech, Gaminvest, EighteenGym, Sobis Turism, Ascom, msg systems. Fiecare are repo GitHub și un owner (`sebiboga`, `florinbighiu`, `AlexColceriu`, `BalaciSofia`, `cristian-alexutan`, `emtreila`, `ale23yfm`, `peviitor-scrapers`). |
| **URL-uri cu protocol dublat** | **121** (`cariere.kaufland.rohttps://cariere.kaufland.ro/...`) | 121 linkuri garantat moarte, dintr-un singur bug de concatenare. Lift infinit (100% din sursă). Tool-ul de azi nu are nicio regulă de formă a URL-ului. |
| **Joburi la companii ANAF non-active** | **1.115 `inactiv` + 17 `funcțiune` + 2 `lichidare` = 1.134** | Cel mai grav defect pentru candidat: aplici la o firmă dizolvată. Datele există deja în `company.status`, join pe CIF. Nemăsurat. |
| **`title_html_entity`** | **1.890 (3,22%)** | Aceeași clasă cu `company_html_entity`, dar pe titlu. Regula nu există. |
| **Companii duplicate prin zero-uri de început** | **13** | `00361820` vs `361820` = RAIFFEISEN BANK SA de două ori. Același artefact care producea „9.410 orfani". |
| **`existingJobsCount` = 0 pe toate cele 16.117 companii** | **100%** | Contor denormalizat mort în core-ul de producție. |
| **Companii din catalog fără niciun job** | **6.376 din 16.104 (39,6%)** | Catalogul e umflat cu firme fără ofertă. |
| **URL duplicat modulo query string** | **1.099** | Același anunț indexat de mai multe ori cu `?utm=`/`?page=` diferit. |
| **`career` URL prezent** | **68 din 16.104 (0,4%)** | Nu se poate construi un scraper nou fără să știi unde e pagina de carieră. |
| **Prospețimea catalogului `company`** | `lastScraped` p50 = **34 zile**, p90 = **53**, max = **53** | Jumătate din catalogul de firme e verificat ultima oară acum peste o lună. |

### 3.6 Verificarea cifrelor din brief

| Afirmație din brief | Măsurat | Verdict |
|---|---|---|
| 58.684 joburi, 16.117 companii | idem | ✔ |
| `salary` populat pe ZERO documente | `q=salary:*` → **0** | ✔ |
| 56.281 fixed / 1.975 country / 228 junk / 200 international | idem, exact | ✔ |
| 55.873 `loc_needs_fix` | idem | ✔ cifra, ✘ interpretarea (§3.4) |
| 24.651 duplicate (42%) | idem, 42,01% | ✔ |
| 3.742 companii cu entități HTML | idem | ✔ |
| 19 orfani (nu 9.410) | idem, **toți 19 din arrise.com** | ✔ |
| 38 joburi adult, cu fals pozitiv | idem, 97,4% din top-3 surse | ✔ |
| ALL-CAPS 16,53% | idem, 9.701 | ✔ |
| „tags și workmode ~99,6%" | `missing_tags` 236 (99,60%), `missing_workmode` 241 (99,59%) | ✔ |
| COR acoperă 39,5% | **neverificat în acest raport** — rularea completă a `lib/cor.js` peste 58.684 titluri a depășit bugetul de timp al sesiunii. Se ia ca dat, nu ca măsurat. | ⚠ |
| „acoperire ~100% pentru … date" | `date` e populat 100%, **dar e timestamp de re-index, nu dată de publicare** (interval total: 4 zile). | ✘ înșelător |

**Corecții pe care le aduc la brief:**

1. `expirationdate` și `vdate` sunt în schemă și **populate pe 0 documente** — la fel de goale ca `salary`. Nu doar salariul lipsește; **lipsește orice noțiune de expirare**.
2. Câmpul `source` **există în schema `job` și e gol pe toate cele 58.684 de documente.** Sursa trebuie parsată din `url` — exact ce a trebuit să fac aici. Popularea lui e o schimbare de o linie în pipeline care face toată această analiză nativă în Solr.
3. `status` are doar două valori: `scraped` 58.613 / `activ` 71. Nu e un câmp de stare utilizabil.
4. 5 URL-uri nu încep cu `http` — 4 path-uri relative (ARRK) + 1 `mailto:hr@reinert-romania.ro`.

---

## 4. Ce trebuie să scrie pe primul ecran

### Ce e greșit acum

Scorul compozit **50/100** este o metrică de vanitate, din trei motive măsurabile:

1. Este dominat de o regulă care nu măsoară un defect. `loc_needs_fix` are pondere 6 și se aprinde pe 95,21% → singură contribuie ~28% din penalizarea totală. **Scorul e, în bună parte, un raport despre cât de mult muncește propriul normalizator.**
2. Nu se poate acționa asupra lui. „50" nu numește nicio sursă, niciun repo, niciun om.
3. Ascunde exact semnalul util: dacă `iajob.ro` se strică complet mâine (16,8% din index), scorul scade cu câteva puncte și nimeni nu observă. Dacă `makitajobs.ro` (18 joburi, 100% junk) se repară, scorul nu se mișcă deloc. **Scorul e insensibil la evenimentele care contează și sensibil la cele care nu contează.**

### Ce propun în loc

**Un tabel de surse. Atât.** Aproximativ 30 de rânduri acoperă 89,5% din index.

```
SURSĂ                 JOBURI   Δ24h   DEFECT DOMINANT              RATĂ    LIFT   PROPRIETAR
─────────────────────────────────────────────────────────────────────────────────────────────
⛔ makitajobs.ro           18      0   locație junk                 100%    257x   inviitor
⛔ applytojob.com          87     +2   fără tags                   97,7%    243x   inviitor
⛔ tremend.com            115   +115   fără workmode                87,0%    212x   peviitor-scrapers/tremend…
⛔ cariere.kaufland.ro    121    +70   URL cu protocol dublat        100%      ∞    inviitor
⛔ globallogic.com         73     +8   locație junk                 68,5%    176x   inviitor
⚠  keysight.com            91     +5   doar nivel de țară           91,2%     27x   inviitor
⚠  anofm.ro             8.026 +4.872   titluri ALL-CAPS            95,6%    5,8x   inviitor
⚠  iajob.ro             9.877 +6.401   companie cu &amp;           26,3%    4,1x   inviitor
⚠  jobviewtrack.com     6.259 +2.603   duplicate                   87,9%    2,1x   inviitor
✔  bestjobs.eu          6.920 +4.304   —                              —       —    inviitor
```

Plus **exact trei** carduri deasupra, nu un cadran:

1. **`19 / 64 scrapere dedicate au produs 0 joburi`** → click = lista cu repo-uri și owneri.
2. **`1.134 joburi la firme non-active la ANAF`** → click = rândurile.
3. **`Ultimul ingest: 2026-08-24 09:19` (acum 1 zi)** → dacă trece de 48h, e roșu. Un pipeline oprit e defectul numărul unu și azi nu îl vede nimeni.

### Apărare împotriva alternativelor

- *„Un scor unic e bun pentru comunicare externă."* — Da, dar atunci e un raport public (§5, poziția 6), nu ecranul de lucru. Cele două publicuri sunt diferite; ecranul de lucru trebuie să răspundă „ce fac acum", nu „cum stăm".
- *„Lista de reguli e mai generală."* — Lista de reguli e ortogonală pe unitatea de acțiune. Un mentenor nu repară „entități HTML"; repară `iajob-scraper`. Regulile rămân, dar ca **a doua coloană**, nu ca navigație principală.
- *„Poate utilizatorul chiar vrea să vadă rândurile."* — Da, și principiul din ANALIZA-UI (*„nu există cifre moarte"*) rămâne intact: fiecare celulă din tabel e un drill-down. Se schimbă doar ce e pe axa verticală: **sursa**, nu regula.

---

## 5. Ce lipsește complet — clasat după valoare pentru mentenor

| # | Ce | Valoare | Ce necesită |
|---|---|---|---|
| **1** | **Alarma de scraper mort.** 19 din 64 de repo-uri produc 0 joburi. | **Maximă.** Este singurul output care spune direct „repară asta, iată repo-ul". Zero ambiguitate, owner identificat. | **Nimic nou.** Join `company.scraperFile` × `job.cif` normalizat. ~40 de linii. Datele există azi. |
| **2** | **Scorecard pe sursă cu lift.** | **Maximă.** Reordonează toată munca după impact real. | **Nimic nou.** O singură scanare (6 s, deja făcută de `materialize`) + parsare host din `url`. Ideal: peviitor populează câmpul `source`, care e deja în schemă și gol. |
| **3** | **Snapshot istoric.** Un rând pe sursă pe zi: volum, rate de defect. | **Mare, dar deblocată de #1–2.** Fără istoric nu există „se înrăutățește?", nu există alarmă de regresie, nu există dovada că o reparație a funcționat. | Un fișier append-only (JSONL sau SQLite), scris de un cron zilnic. **Solr nu poate furniza asta retroactiv** — `date` acoperă 4 zile. Valoarea începe după ~2 săptămâni de colectare. Ieftin de construit, scump de așteptat: **de pornit primul, chiar dacă se folosește ultimul.** |
| **4** | **Verificare de linkuri prin eșantion pe sursă.** 50 URL-uri/sursă, nu 58.684. | **Mare.** Ar fi prins cei 121 de `kaufland.rohttps://` instant. Un link mort e singurul defect pe care utilizatorul final îl simte direct. | `lib/links.js` există deja, dar `cache/links.json` are ~200 de intrări și e din 2026-08-20. De reorientat de la „verifică tot" (imposibil) la „verifică 50 pe sursă și raportează rata". |
| **5** | **Reguli de formă a URL-ului.** Protocol dublat, entități HTML în URL, path relativ, `mailto:`. | **Medie-mare.** 121 + 5 rânduri azi, dar cost de implementare aproape nul și prinde regresii viitoare de scraper. | Un regex. Tier `scan`. |
| **6** | **Liveness de companie.** 1.134 joburi la firme ANAF non-active. | **Medie-mare** pentru reputația peviitor. | Join pe `company.status`. Datele există. |
| **7** | **Raport public de calitate.** | **Medie.** Bun pentru credibilitate și pentru atras contribuitori („adoptă un scraper stricat"). | Depinde de #3 pentru trend. O pagină statică generată. |
| **8** | **Writeback de corecții în index.** | **Mică, aproape negativă.** Se șterge la următorul scrape (§0.2). | De construit **doar** ca „patch persistent aplicat la ingest" (o listă de reguli de rescriere aplicată *după* scraper), niciodată ca editare directă în Solr. |

---

## 6. Lista de tăieri — fără menajamente

| De tăiat | Motiv măsurat |
|---|---|
| **Tot ce ține de salariu** (view, grafice, `salary` din `FL`) | `q=salary:*` → **0 documente**. Zero, nu „puține". Un ecran care afișează în mod garantat nimic. |
| **Scorul compozit 50/100** | Insensibil la evenimentele care contează, dominat de o non-regulă (§4). De înlocuit cu cele 3 carduri. |
| **Regula `loc_needs_fix`** (55.873) | Lift 1,05x. Măsoară propriul normalizator, nu date proaste (§3.4). De transformat într-un contor operațional („writeback în așteptare"), scos din lista de defecte și din scor. |
| **Regula `title_allcaps`** ca regulă globală (9.701) | 79,1% dintr-o singură sursă, care este ANOFM — a cărei bază de date **este** cu majuscule. Nu e defect de date, e o convenție de sursă. De degradat la o notă pe rândul `anofm.ro` din scorecard: *„titluri în majuscule — normalizează la ingest"*. O linie de cod la ingest rezolvă 7.675 de rânduri; o regulă în UI nu rezolvă niciunul. |
| **Regula `loc_country`** (1.975) | Proprietarul spune că e corect pentru remote. Măsurat: se confirmă ca semnal de sursă (keysight.com 91,2%, fjobs.ro 41,2%), nu ca defect de rând. De mutat în scorecard ca „precizie de locație", nu în lista de defecte. |
| **`title_too_short`** (2 rânduri) | Două rânduri din 58.684. Costă un slot de UI cât `dup_title_company`. |
| **Tier-ul `judge` (AI) pentru `title_adult`** | 38 de candidați. Un om îi citește în 4 minute. Infrastructura (cache de verdicte, hash de prompt, override, endpoint gated, buget de 300 docs) este **mai complexă decât problema**. De păstrat mecanismul de override uman; de scos apelul la model pentru acest volum. Se re-justifică doar dacă apare o regulă cu mii de candidați ambigui. |
| **`cache/embedding_vectors.json` — 156 MB** | Nu e citit de niciun cod din calea `server/` sau `lib/rules.js`. 156 MB într-un repo de tool. |
| **Acțiunile `wipe` / `repopulate`** | Nu servesc job-to-be-done-ul. `repopulate` invocă un script PowerShell dintr-un director temporar de sesiune Claude (`server/actions.js:15-19`) — o dependență care va dispărea. Un tool de audit care poate șterge indexul auditat e un risc fără contrapartidă. |
| **Duplicate de fișiere:** `app.js.old` (47 KB), `index.html.old`, `style.css.old`, `api.js.bak`, `solr.js.bak` | Zgomot. Există git. |
| **`dup_title_company` ca listă de 24.651 rânduri** | Nu de tăiat, de **reformulat**. Măsurat, top grupuri: 617× „operator la fabricarea altor produse chimice / SIAD ROMANIA", 557× „asistent medical generalist / SACRO", 543× „inspector tehnic / IMATEST 2006". Acestea sunt **posturi multiple reale** din baza ANOFM (un angajator caută 617 oameni), nu re-ingest. De separat în două lucruri diferite: *„aceeași sursă a scris de N ori același anunț"* (defect, jobviewtrack.com 87,9%) vs *„angajatorul are N posturi"* (nu e defect, e un câmp `headcount` care lipsește din schemă). Numărul unic de 24.651 amestecă un bug cu o funcționalitate lipsă. |

---

## 7. Ce împrumut de la tool-urile comparabile — și unde analogia se rupe

> Notă de onestitate: sesiunea a fost dedicată măsurării pe date reale, iar cercetarea
> pe web a rămas la nivel de cunoștințe generale despre aceste tool-uri, nu de citire
> a documentației lor în această sesiune. Marchez ca atare — framing-ul de mai jos e
> transferabil, dar nu e citat din surse verificate acum.

**Ce se transferă:**

- **dbt tests / Great Expectations — „testul aparține modelului, nu tabelei finale."**
  Echivalentul aici: testul aparține *scraperului*, nu indexului. Exact concluzia din §2.
  De împrumutat și distincția `error` / `warn`: în GE și dbt, un test are severitate
  configurabilă și una singură dintre ele oprește pipeline-ul. Aici: doar defectele cu
  lift ≥ 4x pe o sursă ar trebui să fie „error"; restul sunt „warn" și nu apar pe primul ecran.

- **Soda / Elementary — „anomaly detection pe volum, nu doar reguli pe valori."**
  Cea mai transferabilă idee din tot setul. Un scraper stricat rareori produce date
  *invalide*; produce **zero date**, sau brusc jumătate. Cele 19 repo-uri cu 0 joburi
  și cele 54 de domenii nerevăzute la ultimul ingest sunt anomalii de volum, nu
  încălcări de regulă — și niciuna dintre cele 14 reguli actuale nu le poate exprima.
  **Aceasta e cea mai mare lacună conceptuală a tool-ului de azi.**

- **Monte Carlo / Datafold — „ownership și blast radius."**
  Fiecare incident are un owner și un număr de rânduri afectate. Aici: `scraperFile`
  → repo GitHub → contribuitor (`sebiboga`, `florinbighiu`, …), iar blast radius =
  volumul sursei. Ambele există deja în date și niciunul nu e afișat.

- **OpenRefine — clustering pe valori.** Modelul potrivit pentru cele 3.742 de
  `&amp;` și cele 13 CIF-uri duplicate: grupează valorile echivalente, arată
  reprezentantul, aplică o dată. Dar (vezi mai jos) aplicarea trebuie să meargă în
  pipeline, nu în index.

- **Google Jobs / schema.org `JobPosting`** — cerințe: `title`, `hiringOrganization`,
  `jobLocation`, `datePosted`, `validThrough`. Măsurat pe acest index: `datePosted`
  real **nu există** (`date` e timestamp de re-index), `validThrough` = `expirationdate`
  este **gol pe 100% din documente**. Deci indexul peviitor **nu ar trece validarea
  Google for Jobs**, indiferent de toate celelalte reguli. Asta e o observație de
  produs mai importantă decât 9.701 titluri cu majuscule și nu apare nicăieri în tool.

**Unde analogia NU ține:**

1. **Nu există „sursă de adevăr" de comparat.** dbt/Datafold compară o transformare cu
   inputul ei. Aici inputul e o pagină web care s-a schimbat și nu mai există. Nu se
   poate face diff; se poate doar detecta *deriva* față de propriul trecut — de unde
   necesitatea absolută a snapshot-urilor (§5, poziția 3).

2. **Nu există SLA și nu există pager.** Monte Carlo presupune o echipă de garda.
   peviitor are voluntari cu două ore pe săptămână. Deci: **fără alerte push, fără
   escaladare** — doar o listă scurtă, stabilă, ordonată, care arată la fel când te
   întorci sâmbăta viitoare. Un tool care generează mai multe alerte decât ore de
   voluntariat este un tool care se ignoră.

3. **Idempotența e inversă.** În dbt, rulezi transformarea din nou și obții același
   rezultat. Aici, indexul se rescrie complet la fiecare ciclu (19.507 `deletedDocs`,
   toate documentele scrise în ultimele 4 zile). **Orice remediere care nu e în cod
   e temporară.** Asta invalidează întreaga clasă „data quality workbench" (OpenRefine,
   partea de write-back a Datafold) pentru acest context.

4. **„Calitate" aici înseamnă parțial „legalitate/reputație", nu doar corectitudine.**
   Cele 38 de anunțuri adult și cele 1.134 de joburi la firme dizolvate nu sunt
   probleme de schemă — sunt probleme de încredere publică pentru un proiect
   open-source finanțat prin voluntariat. Niciun tool de data quality nu are această
   categorie; aici merită o secțiune proprie.

---

## 8. Roadmap clasat

**Acum (fără infrastructură nouă, datele există):**
1. Ecran-scorecard pe sursă, ordonat după `lift × volum`; cele 3 carduri de sus.
2. Alarma „scraper mort": 19/64 repo-uri cu 0 joburi, cu link către repo.
3. Regulile noi ieftine: formă de URL (121+5), `title_html_entity` (1.890), companie non-activă (1.134).
4. Tăierile din §6 — în special scorul compozit, salariul și `loc_needs_fix` din lista de defecte.

**Următorul (necesită o schimbare mică în pipeline):**
5. Popularea câmpului `source` din schema `job` (azi gol pe 58.684 documente) → toată analiza de mai sus devine un simplu facet Solr, în loc de o scanare completă.
6. Snapshot zilnic append-only per sursă. **De pornit imediat**, chiar dacă UI-ul îl folosește peste două săptămâni.
7. Verificare de linkuri prin eșantion (50/sursă), raportată ca rată de sursă.

**Mai târziu:**
8. Trend și alarmă de regresie (depinde de 6).
9. Raport public de calitate.
10. Reguli de rescriere aplicate *la ingest* (nu în index) pentru: majuscule ANOFM, decode HTML, sectoare București.

---

## 9. Cea mai mare schimbare, într-o frază

> **Scoate scorul 50/100 și lista de reguli de pe primul ecran și pune în loc un tabel
> cu ~30 de surse, ordonat după `lift × volum`, cu repo-ul GitHub responsabil pe fiecare
> rând — pentru că defectele reale au lift 4x–257x pe o sursă nominalizabilă, iar orice
> reparație scrisă pe un rând este ștearsă de următorul scrape.**
