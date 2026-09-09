# Unde și cum ar putea intra un model AI în BAROMETRU

Research efectuat pe 5 septembrie 2026, fără presupunerile discuțiilor
anterioare. Surse la final.

---

## Ce spune literatura

### 1. Regulile deterministe sunt podeaua, modelul e plafonul

Evaluatoarele deterministe prind între 30% și 60% din defecte înainte ca un
model să fie chemat, cu trei avantaje pe care un model nu le are: fiecare eșec
are o cauză auditabilă, latența e zero, costul e zero. Modelul are sens acolo
unde criteriul e deschis, unde există multe forme corecte de suprafață, sau
unde defectul e semantic și nu se poate exprima ca schemă sau expresie
regulată.

**Pentru noi:** stratul determinist e deja construit și acoperă exact ce
descrie literatura ca fiind teritoriul lui. Nu se înlocuiește.

### 2. Ieșirea structurată garantează validitatea, nu corectitudinea

Asta contrazice direct presupunerea cu care porniserăm. Un `enum` sau un set
închis de răspunsuri garantează că modelul returnează o valoare *permisă*. Nu
garantează că e valoarea *potrivită*. Fenomenul are un nume în literatură,
*enum hallucination*: gramatica impune valori valide, dar nu le ponderează
după context.

Cifra care contează: pe un benchmark dedicat, modelele depășesc 84% la
validitatea JSON-ului, dar **niciunul nu trece de 80,4% acuratețe a valorii**.
Diferența e exact halucinația pe care validarea de schemă nu o prinde.

**Pentru noi:** un cod COR ales dintr-o listă va fi întotdeauna un cod COR
real. Va fi codul greșit în aproximativ unul din cinci cazuri dificile. Deci
orice verdict de model trebuie să fie vizibil lângă intrarea lui și marcat ca
atribuit de model, nu prezentat ca măsurătoare.

### 3. Pentru potrivirea titlurilor pe o nomenclatură, embeddings bat modelul de limbaj

Domeniul e studiat: JAMES, JobBERT, encodere multilingve de titluri antrenate
pe ESCO. O variantă Sentence-BERT ajustată pe titluri de posturi atinge 0,86
acuratețe pe nivelul de 5 cifre al unei nomenclaturi naționale. Metoda
standard e regăsire prin similaritate cosinus peste un index vectorial, cu
prag calibrat pentru „niciun rezultat”.

Două constatări practice din literatură: câștigul cel mai mare vine din a
încorpora **context structurat**, nu numele gol; și normalizarea se face
**în interiorul setului de candidați**, nu global.

**Pentru noi:** clasificarea ocupațiilor, pe care o consideram cazul ideal
pentru un model de limbaj, e de fapt o problemă de embeddings. Reproductibilă,
fără cost per apel, rulează local, nu depinde de disponibilitatea unui
furnizor.

### 4. Duplicatele se rezolvă determinist, iar problema e mare în industrie

Proporția de duplicate în anunțuri colectate de pe job boards ajunge la
**50-80%**. Sistemul de referință pentru domeniu, Apollo, folosește blocking,
shingling, eliminarea textului boilerplate și similaritate Jaccard, și bate
SimHash și shingling simplu la precizie și acoperire. MinHash cu LSH evită
comparația tuturor perechilor.

Costul e argumentul decisiv: potrivirea semantică prin embeddings e precisă
dar scumpă la scară; abordările probabiliste dau aproape aceeași calitate la o
fracțiune din calcul. O lucrare recentă atinge calitate bună de deduplicare cu
**sub 1% cost de verificare neuronală**.

**Pentru noi:** nici aici nu e nevoie de model. Dacă vreodată se reia
subiectul, drumul e MinHash peste titlu plus companie plus localitate, nu un
model.

### 5. Detectarea anunțurilor false e singurul loc unde învățarea automată domină clar

Există set de date public, EMSCAD, cu 17.880 de anunțuri și circa 800
frauduloase, cu 18 atribute. Modelele clasice ating 96-98% acuratețe;
Fraud-BERT folosește embeddings contextuale peste descrierea postului.
Trăsăturile care contează: frecvența anumitor cuvinte, tipul domeniului de
email, prezența salariului.

**Pentru noi, cu o limitare severă:** indexul nostru nu conține descrierea
postului. Avem titlu, companie, CIF, locație, etichete. Modelele din
literatură se sprijină puternic pe descriere. Deci acuratețea raportată acolo
nu se transferă direct.

### 6. Un model care judecă trebuie calibrat, altfel e supra-încrezător

Deciziile unui model-judecător sunt nedeterministe chiar și cu criteriu fix.
Practica recomandată: calibrare pe un set mic adnotat manual înainte de
aplicarea la scară, eșantionare stratificată pe încredere în loc de
eșantionare aleatoare, și abținere explicită. Eșantionarea aleatoare
subreprezintă exact cazurile care contează, adică răspunsurile greșite date cu
încredere mare.

---

## Unde își merită locul, în ordinea valorii

### A. Propunerea de reguli noi, offline, cu om în buclă

Literatura o menționează direct: un model poate analiza schema, înregistrări
eșantion și statistici de profilare, și **poate deduce reguli de validare**,
accelerând construirea unui cadru de calitate a datelor.

Asta se potrivește perfect peste ceea ce avem, și e singura utilizare cu risc
zero de halucinație în producție: **ieșirea modelului nu ajunge niciodată la
utilizator.** Ajunge la noi, ca propunere de regulă.

Concret: o dată pe lună, un script ia 500 de anunțuri pe care cele 46 de
reguli le declară curate, le trimite modelului împreună cu contractul
peviitor_core, și întreabă ce tipare suspecte vede care nu sunt acoperite.
Ieșirea e o listă de reguli propuse, în text. Noi le citim, le respingem sau
le implementăm determinist.

Precedentul din acest proiect: caracterele chirilice ascunse în „Rаdiologie”
și literele Unicode decorative au fost găsite din întâmplare, uitându-ne la
date. Un model care se uită sistematic ar fi găsit tiparul mai devreme.

Cost: circa 20 de apeluri pe lună. Sub un dolar.

### B. Clasificarea ocupațiilor, prin embeddings, nu prin model de limbaj

Registrul COR are 4.422 de ocupații și e deja în repo-ul vechi. Metoda din
literatură: se calculează o dată vectorii celor 4.422 de ocupații, apoi
vectorul fiecărui titlu distinct, și se ia cel mai apropiat peste un prag.
Sub prag, titlul rămâne neclasificat și se afișează ca atare.

Rulează local, o singură dată la adăugarea unui titlu nou, fără cheie API,
fără cost per apel, reproductibil între rulări. Cost: o dependență npm și
memorie pentru 4.422 de vectori, adică sub 10 MB.

Un model de limbaj intră aici doar pe reziduul reziduului, adică titlurile
unde primii doi candidați sunt la distanță aproape egală. Acolo alege între
două opțiuni, nu între 4.422.

### C. Diagnoza per sursă

Singura sarcină din tot produsul care e sinteză, nu măsurătoare, deci singura
unde modelul face ceva ce nicio regulă nu poate face.

Intrare: pentru un site, cifrele deja măsurate, adică numărul de anunțuri și
câte pică la fiecare regulă. Ieșire: două-trei propoziții despre ce e probabil
stricat în scraper și ce ar trebui schimbat.

Riscul rămâne, pentru că e text liber. Atenuare: modelul primește **doar
cifrele**, i se cere să nu afirme nimic care nu e printre ele, iar textul se
afișează lângă tabelul cu aceleași cifre, ca cititorul să verifice fiecare
afirmație. Etichetat explicit ca interpretare, nu ca măsurătoare.

Cost: 487 de surse, dar doar circa 130 au peste 20 de anunțuri. O dată pe zi,
cu Haiku prin Batch API, sub 10 cenți pe lună.

### D. Conținut la limită: adult, înșelător, suspect

Reziduul regulilor deterministe. Astăzi sunt câteva zeci de titluri pe zi.
Necesită calibrare pe un set adnotat manual, conform punctului 6, și abținere
explicită. Valoare reală dar mică la volumul actual.

---

## Unde nu are voie să intre

- **În verdictul de validitate.** Numărul de pe prima pagină rămâne integral
  determinist. Un model care contribuie la el face cifra iremproductibilă de
  la o zi la alta.
- **Ca generator de date stocate.** Nicio denumire de firmă, CIF, localitate
  sau titlu produse de model nu ajung în `runs/`.
- **În drumul critic.** Analiza trebuie să se termine identic dacă furnizorul
  e indisponibil.

---

## Integrarea cheii API, concret

Proiectul are astăzi **zero dependențe npm** și rulează pe Node 20, care are
`fetch` inclus. Există deja `src/env.js` care încarcă `.env`. Deci integrarea
nu cere nici SDK, nici pachete.

**Configurare:**

```
# .env, deja în .gitignore
ANTHROPIC_API_KEY=sk-ant-...
```

`.env.example` primește linia goală, ca documentație. Cheia nu ajunge
niciodată în repo, nici în imaginea Docker: `.dockerignore` exclude deja
`.env`, iar pe Render se pune în dashboard cu `sync: false`, exact ca
`SOLR_PASS`.

**Regula de proiectare, dat fiind că serverul e public și fără autentificare:**
cheia se citește **numai** în procesele care rulează din linia de comandă, nu
în `src/server.js`. Serverul nu are niciun endpoint POST și nu trebuie să
capete unul. Un vizitator nu poate declanșa niciun apel plătit, pentru că nu
există cale prin care să ajungă la cod care cheamă modelul. Asta a fost exact
greșeala versiunii anterioare a proiectului, unde `POST /api/judge` era
accesibil din internet.

**Model și cost.** Pentru clasificare și sinteză scurtă, Claude Haiku 4.5 la
1 $ / 5 $ per milion de tokeni intrare / ieșire. Prin **Message Batches API**
prețul scade la jumătate, iar rezultatele vin în cel mult 24 de ore, ceea ce
se potrivește perfect cu o analiză programată o dată pe zi. Un batch acceptă
până la 100.000 de cereri.

**Cache pe disc, comis în repo.** Cheie: hash din intrare plus prompt plus
model. Un titlu deja clasificat nu se retrimite niciodată. Fișierul intră în
git, deci un container proaspăt nu recumpără nimic. Versiunea anterioară a
ținut cache-ul în `cache/`, care se ștergea la fiecare redeploy, și de aceea
plătea aceleași verdicte la nesfârșit.

---

## Recomandare

**Punctul A, propunerea de reguli, ca prim pas.** Motive: e singura utilizare
unde modelul nu poate strica nimic pe ecran, pentru că ieșirea trece prin noi;
costă sub un dolar pe lună; și atacă limitarea reală a produsului, care nu e
lipsa de inteligență în evaluare, ci faptul că regulile există doar dacă ne-a
trecut cuiva prin cap să le scrie.

**Punctul B, ocupațiile, ca al doilea**, dar prin embeddings, nu prin model de
limbaj, și deci fără cheie API.

Punctele C și D au sens abia după ce primele două stau în picioare.

---

## Surse

**Determinist versus model**
- Deterministic vs. LLM Evaluators, studiu de compromis 2026: https://dev.to/anshd_12/deterministic-vs-llm-evaluators-a-2026-technical-trade-off-study-11h
- Deterministic LLM Evaluation Metrics 2026: https://futureagi.com/blog/deterministic-llm-evaluation-metrics-2026/
- Data Quality in the Age of LLMs: https://medium.com/@tomkrol_39593/data-quality-in-the-age-of-llms-27b82cf26a87

**Ieșiri structurate și limitele lor**
- Your JSON Is Valid but Your Data Is Wrong: https://towardsdatascience.com/your-json-is-valid-but-your-data-is-wrong-five-failure-modes-llm-structured-outputs-wont-catch/
- JSONSchemaBench: https://arxiv.org/pdf/2501.10868
- The Structured Output Benchmark: https://arxiv.org/pdf/2604.25359
- Ghid de constrained decoding: https://www.aidancooper.co.uk/constrained-decoding/

**Titluri de posturi și nomenclaturi**
- JAMES, Job Title Mapping with Multi-Aspect Embeddings: https://arxiv.org/pdf/2202.10739
- Ontology-Aligned Embeddings for Labour Market Analytics: https://arxiv.org/pdf/2509.04942
- Occupation, Skill and Qualification Linking cu ESCO: https://arxiv.org/html/2512.03195
- Comparative Study of Embedding and Classification for O*NET-SOC: https://atrium.lib.uoguelph.ca/items/bdb31590-88d4-4c7e-801c-15386028d50e

**Duplicate**
- A Framework for Duplicate Detection from Online Job Postings (Apollo): https://dl.acm.org/doi/fullHtml/10.1145/3486622.3493928
- SemHash-LLM: https://arxiv.org/html/2607.01601
- Near-deduplication la scară, BigCode: https://huggingface.co/blog/dedup

**Anunțuri false**
- Detection of Fake Job Postings, NLP + ML: https://dl.acm.org/doi/abs/10.1007/s11063-021-10727-z
- Machine Learning for Fake Job Detection: https://ijarcce.com/wp-content/uploads/2024/08/IJARCCE.2024.13824.pdf

**Calibrarea unui model-judecător**
- Overconfidence in LLM-as-a-Judge: https://arxiv.org/html/2508.06225v2
- Calibrarea cu adnotări umane: https://galileo.ai/blog/calibrate-llm-judge-human-annotations

**Cost și API**
- Anthropic Message Batches API, 50% reducere: https://www.respan.ai/articles/anthropic-message-batches-api
- Anthropic API Pricing 2026: https://www.finout.io/blog/anthropic-api-pricing

---

# Partea a doua: integrare, MCP, ecosistem open source, rapoarte

Research continuat, aceeași zi.

## Ce am căutat și ce nu există

Am interogat registrul oficial de conectori după „data quality”, „validation”,
„reports”, „pdf”, „tables”, „observability”. **Zero rezultate.** Nu există un
conector oficial pentru calitatea datelor.

În ecosistemul comunitar există unul singur relevant, `gx-mcp-server`, care
expune Great Expectations ca unelte MCP: încarci un CSV, definești așteptări,
rulezi validarea. Nu ne folosește. Presupune că datele vin la el ca fișier și
că regulile se scriu în vocabularul generic al bibliotecii. Regulile noastre
verifică cifra de control a unui CIF, potrivesc localități pe registrul SIRUTA
și citează clauze din contractul peviitor_core. Niciuna nu se exprimă acolo.

## Direcția care contează e inversă: BAROMETRU să fie el serverul MCP

Literatura de anul acesta formulează asta explicit: **MCP e noul API intern**,
iar recomandarea de pornire este *read-only*, cu acces extins abia după ce se
observă cum este folosit.

BAROMETRU este deja read-only prin construcție. Are un API JSON curat. Și
deține exact datele pe care cineva ar vrea să le interogheze în limbaj
natural: „care dintre scrapere e cel mai slab și din ce cauză”, „arată-mi
anunțurile cu CIF invalid de pe iajob.ro”, „ce s-a schimbat față de săptămâna
trecută”.

Avantajul decisiv față de orice altă integrare: **noi nu plătim nimic, iar
modelul nu poate inventa cifre.** Persoana care întreabă aduce propriul Claude;
cifrele vin din uneltele noastre, nu din memoria modelului. Iar dacă cineva
cere o valoare pe care nu o avem, unealta returnează gol, nu o aproximare.

### Cum arată concret

MCP este JSON-RPC 2.0 peste intrarea și ieșirea standard. Se implementează în
circa 150 de linii fără nicio dependență, deci proprietatea de „zero pachete
npm” se păstrează. Alternativ, SDK-ul oficial, dar ar fi prima dependență din
proiect.

Patru unelte acoperă tot:

| unealtă | ce întoarce |
|---|---|
| `sinteza` | cifrele din `runs/latest.json`: valide din total, pe criterii, plus evoluția |
| `reguli` | catalogul, cu numărul și exemplele reale pentru fiecare regulă |
| `anunturi` | același filtru ca `GET /api/jobs`: după regulă, sursă, județ, companie |
| `sursa` | fișa unui site: câte anunțuri, ce reguli încalcă, ce adrese sunt inaccesibile |

Securitate: nu există metodă de scriere nicăieri în proiect, deci suprafața de
risc se reduce la citirea unor date deja publice. Nu este nevoie de token, de
OAuth, de nimic. Se rulează local, lângă analiză.

**Este integrarea cu cel mai bun raport valoare/risc din tot ce am găsit.**

## Ecosistemul open source: ce merită preluat, ce nu merită adoptat

| proiect | stare 2026 | ce merită preluat |
|---|---|---|
| **Great Expectations** | GX Cloud cumpărat de FICO și închis public din 1 iunie 2026; proiectul open source trecut sub tutela Fivetran | **Data Docs**: un site HTML static generat din rezultatele validării, versionat, cu istoric cronologic pe rulare |
| **Soda Core** | din v4, ianuarie 2026, a trecut de la Apache 2.0 la Elastic License 2.0 — source-available, nu open source; gratuit intern, interzis ca serviciu găzduit pentru terți | **SodaCL**, limbajul de reguli, remarcabil de lizibil |
| **DQOps** | activ, open source | **incidente**: gruparea problemelor similare într-un singur caz, cu notificare către responsabil |
| **MobyDQ** (Ubisoft), **dcs-core**, **OHDSI DQD** | active, de nișă | tipare de alertare, nimic structural |

**Concluzie: niciunul nu se adoptă.** Toate sunt Python plus SQL, orientate pe
tabele, cu vocabular generic. Coloana vertebrală a produsului nostru este
faptul că fiecare regulă citează clauza de contract pe care o aplică. Rescrise
într-un limbaj generic, regulile pierd exact asta.

Merită preluate trei tipare, toate implementabile în ce avem:

1. **Incidente.** Astăzi arătăm 46 de reguli separat. Un scraper defect
   produce simultan zece dintre ele. Gruparea într-un singur caz per sursă, cu
   titlu și responsabil, corespunde mai bine felului în care se repară.
2. **Istoric pe rulare.** Avem `runs/history/`, dar îl folosim doar pentru o
   comparație la 7 zile. Un grafic pe 90 de zile per regulă ar arăta dacă o
   corecție la un scraper s-a menținut.
3. **Documentație generată.** Catalogul de reguli, cu clauza și exemplele,
   exportat ca pagină statică pe care un autor de scraper o poate citi fără să
   deschidă aplicația.

## Rapoarte: PDF, tabele, și ce este de fapt necesar

**PDF.** Răspunsul canonic în Node este Puppeteer cu Chromium headless. Costul
este între 200 și 400 MB adăugați la instalare, plus probleme pe găzduire fără
server dedicat. Alternativele din 2026 sunt API-uri găzduite, contra cost.

Nu ne trebuie niciuna. **Browserul știe deja să tipărească.** O rută `/raport`
cu foaie de stil `@media print` produce un PDF corect la Ctrl+P, cu zero
dependențe și zero cost. Versiunea anterioară a proiectului făcea exact asta
și a fost una dintre puținele ei decizii bune.

**Tabele.** Un endpoint `GET /api/export?...&format=csv` peste filtrele care
există deja. Câteva zeci de linii, nicio dependență.

## Raportarea către cel care repară

Aici este adevărata lipsă. Astăzi produsul spune *ce* este defect și *cine*
repară, dar nu ajunge la acel cineva. Un autor de scraper nu deschide zilnic
un tablou de bord.

Fiecare sursă din pagina Surse corespunde unui depozit `Scrapers_*` din
organizația peviitor-ro. Un job săptămânal poate deschide sau actualiza **o
singură sesizare per scraper**, cu tabelul defectelor lui și legături către
anunțurile concrete. Precedentul este stabilit: GitHub însuși raportează
constatările de calitate prin comentarii de bot pe pull request.

Aceasta cere un al doilea secret, un token GitHub cu drept limitat la sesizări,
și respectă aceeași regulă ca cheia de model: **se citește numai în procesele
din linia de comandă, niciodată în server.**

## Recomandarea revizuită, cu tot research-ul pe masă

Ordinea nu mai este cea din prima parte. Așezate după valoare raportată la risc:

1. **Server MCP peste datele existente.** Fără cheie, fără cost, fără risc de
   halucinație asupra cifrelor, și transformă produsul din tablou de bord în
   sursă pe care o poate interoga orice agent.
2. **Sesizare per scraper, săptămânal.** Duce constatarea la cel care o poate
   repara. Nu are nevoie de model deloc.
3. **Incidente și istoric pe 90 de zile.** Tipare preluate din DQOps și Great
   Expectations, implementate în ce avem.
4. **Propunerea de reguli noi cu ajutorul unui model, offline.** Prima
   utilizare care cere o cheie API. Sub un dolar pe lună. Ieșirea trece prin
   noi înainte să ajungă pe ecran.
5. **Ocupațiile prin embeddings.** Fără cheie API.

Primele trei nu au nevoie de niciun model. Merită făcute înaintea oricărei
integrări de AI, pentru că un model care rezumă un produs incomplet rezumă tot
un produs incomplet.

## Surse, partea a doua

**MCP**
- Specificația, versiunea 2025-06-18: https://modelcontextprotocol.io/specification/2025-06-18
- MCP Is the New Internal API: https://paulojmdias.medium.com/mcp-is-the-new-internal-api-treat-it-like-one-6b09028eb884
- Expose Internal APIs as Governed MCP Tools: https://zuplo.com/blog/expose-internal-apis-as-mcp-tools
- MCP Server Security, bune practici 2026: https://toolradar.com/blog/mcp-server-security-best-practices
- gx-mcp-server: https://github.com/davidf9999/gx-mcp-server

**Ecosistem open source**
- Top open source data quality tools 2026: https://atlan.com/open-source-data-quality-tools/
- Self-Hosted Data Quality Tools 2026: https://www.pistack.xyz/posts/self-hosted-data-quality-tools-great-expectations-soda-dbt-guide-2026/
- Great Expectations Data Docs: https://docs.greatexpectations.io/docs/0.18/reference/learn/terms/data_docs/
- DQOps: https://github.com/dqops/dqo
- MobyDQ: https://github.com/ubisoft/mobydq
- dcs-core: https://github.com/datachecks/dcs-core

**Rapoarte**
- HTML în PDF fără Puppeteer: https://dev.to/custodiaadmin/how-to-generate-a-pdf-from-html-in-nodejs-without-puppeteer-3gg8
- Biblioteci Node pentru PDF, 2026: https://apitemplate.io/blog/how-to-convert-html-to-pdf-using-node-js/
- GitHub, raportarea calității prin bot pe PR: https://docs.github.com/en/code-security/responsible-use/security-and-quality-ai-features
- Reviewbot: https://github.com/qiniu/reviewbot
