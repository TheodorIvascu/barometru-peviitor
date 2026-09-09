# BAROMETRU

Busola calității datelor pentru **peviitor.ro**, motorul de căutare de joburi
open-source. Citește indexul Solr de producție și spune ce e în neregulă cu
datele, cât, și din ce sursă vine.

## Regula unică

**Găsește probleme. Nu le repară.** Nu normalizează, nu corectează, nu propune
corecturi, nu scrie în Solr. Clientul din `src/solr.js` nu are metode de
scriere. Datele derivate stau în `runs/`, niciodată în index.

Două invariante în plus:

- **Doar anunțuri reale de producție.** Nicio fixtură, niciun eșantion
  sintetic în UI. Sinteticele sunt permise doar în `tests/`.
- **Orice cifră se deschide.** Un număr pe care nu poți da click nu poate fi
  verificat. Toate ajung în `GET /api/jobs` și arată anunțurile.

## Contractul

Definiția lui "corect" este **peviitor_core** (<https://github.com/peviitor-ro/peviitor_core>):
schema Job și Company. Se validează împotriva ei, nu se schimbă niciodată.
Fiecare verificare din `src/checks.js` citează clauza pe care o aplică.

## Arhitectura, patru straturi subțiri

```
Solr (doar citire) → Îmbogățire → Verificări ─┐
                                 → Statistici ─┴→ Rulare (runs/) → UI
```

| fișier | rol |
|---|---|
| `src/solr.js` | singurul care vorbește cu rețeaua. count, facet, scan prin cursorMark. Fără scriere. |
| `src/enrich.js` | câmpuri derivate per document: host, județ, cheie CIF, compania din catalog, vârstă |
| `src/locations.js` | clasificator de locații pe registrul SIRUTA (`data/`). Conservator: un match greșit e mai rău decât niciunul |
| `src/cif.js` | cifră de control CIF, cheie de comparație |
| `src/checks.js` | **catalogul de verificări. Acesta e produsul.** Un predicat pur per regulă, cu id, grup, severitate, motiv, clauză |
| `src/links.js` | sondă de linkuri moarte, pe eșantion fix per sursă |
| `src/stats.js` | group-by-uri: județe, companii, titluri, etichete, surse |
| `src/run.js` | o analiză completă; scrie `runs/latest.json` (agregate) și `runs/jobs.json` (rânduri) |
| `src/server.js` | HTTP: static + 3 endpoint-uri GET. Programează analiza |
| `public/` | o pagină, șase ecrane, un sertar pentru anunțuri. ECharts vendorizat |
| `tools/build_map.js` | conturul județelor din TopoJSON-ul oficial geo-spatial.org / ANCPI (CC BY-SA), simplificat pe arce ca vecinii să împartă aceeași graniță |

O verificare **este** un predicat. Numărul ei e câte anunțuri îl satisfac;
rândurile ei sunt exact acele anunțuri. Nimic altceva nu produce cifre, deci
o cifră nu poate contrazice lista din spatele ei.

### Cele trei criterii

Verificările sunt grupate în trei criterii despre fiecare anunț (vezi PRODUS.md
pentru research-ul din spate):

1. **Disponibilitatea postului** — adresă inaccesibilă, companie inactivă fiscal, nevalidat de 30+ zile. Responsabil: peviitor_core
2. **Corectitudinea datelor** — localitate din afara României sau nerecunoscută, CIF fără corespondent, conținut pentru adulți, date de contact. Responsabil: scraperul
3. **Abateri de format** — marcaje HTML, majuscule, etichete, status. Fără efect vizibil pentru utilizator. Pagină separată.

Severitate: `grav` = criteriile 1-2, `minor` = format, `info` = măsurat, necontabilizat.

**Cifra produsului**: câte anunțuri sunt **valide** = trec criteriile 1 și 2.
Peste tot „N din M”, fără scor, fără procente pe grupuri. Un singur procent
există, pe pagina Surse, per sursă.

**Registrul limbii este oficial.** Fără „dă click”, „pică”, „mint”, „de
încredere”, „nu mai e”. Interfața se adresează unei organizații: „Selectați o
valoare”, „Neconformitate”, „Responsabil”, „anunț valid”. Vocabularul e
stabilit; nu se reintroduc formulări colocviale.

**Statisticile** (hartă, companii, ocupații) se calculează pe anunțurile
valide. Neconformitățile se numără pe tot indexul.

**Trend**: fiecare rulare lasă un fișier mic în `runs/history/`; prima pagină
compară cu rularea de acum 7 zile.

### Analiza

Rulează singură: o dată la pornire dacă nu există rulare sau e mai veche de
`RUN_MAX_AGE_HOURS` (22), apoi o verificare orară. Nu există buton, nu există
POST, nu există login. Nu există nimic care să coste bani.

Pași: companii → anunțuri (îmbogățite) → sondă linkuri → verificări → statistici → salvare.
Durata: câteva minute, cea mai mare parte în sondă.

`seed/latest.json` e o copie a agregatelor, livrată cu aplicația, ca un
container proaspăt să arate cifre reale înainte de prima rulare. Rândurile nu
se livrează; sertarul răspunde 503 cu un mesaj clar până termină prima analiză.
Regenerare: `node tools/seed.js`.

### Fără AI în v1

Deliberat. Versiunea anterioară a proiectului avea trei furnizori de modele,
un chat, verdicte care dispăreau la restart și bugete cheltuite de vizitatori.
Verificările deterministe prind schema, CIF-ul, HTML-ul, datele personale,
completitudinea și majoritatea locațiilor. Când v1 e stabil, un al cincilea
strat, **Adjudecare**, poate lua doar reziduul a două verificări (conținut
adult, locații de nerecunoscut) și clasificarea COR a titlurilor, ca proces
separat, cu cache pe hash de conținut, comis în repo.

## Rulare

```bash
cp .env.example .env     # completează SOLR_PASS
npm test                 # offline: clasificator locații, CIF, fiecare verificare
npm run analiza          # doar analiza (--no-links refolosește sonda anterioară)
npm run server           # interfața, pe http://localhost:7777
```

Fără dependențe npm. Node 20+.

## Unde rulează

Analiza și afișajul stau în locuri diferite, din cauza discului.

**Analiza** rulează într-un GitHub Action, în fiecare noapte la 03:10 UTC
(`.github/workflows/analiza.yml`). Evidența intrărilor și istoricul
evoluției trăiesc în cache-ul Actions, care persistă între rulări. Rezultatul,
`latest.json` și `jobs.ndjson.gz`, se publică la release-ul
`analiza`, mereu același, înlocuit la fiecare rulare.

**Afișajul** rulează pe Render, planul gratuit, cu `ANALIZA=off`. La
pornire, `tools/fetch-latest.js` aduce rezultatul din release. Serverul nu
calculează nimic și nu are nevoie de acces la Solr.

Motivul separării: pe planul gratuit discul e efemer și se șterge la fiecare
repornire, redeploy **și adormire**, iar serviciul adoarme după 15 minute fără
trafic. Dacă analiza ar rula acolo, evidența intrărilor s-ar pierde de câteva
ori pe zi și fiecare trezire ar porni un calcul de câteva minute pe o zecime de
procesor.

Un singur secret: `SOLR_PASS`, ca secret de repo pentru Action. Render nu are
nevoie de niciunul.

## Memoria

Planul gratuit are 512 MB. Trei lucruri țin analiza sub jumătate din ei:

- rândurile se scriu **în flux**, câte unul pe linie, în `runs/jobs.ndjson`.
  Serializarea lor într-un singur șir urca procesul la 784 MB.
- serverul le citește tot **în flux** (`src/rows.js`), deci nu ține indexul
  în memorie. Fișierul e sortat descrescător după dată la scriere, deci citirea
  vine deja în ordinea afișării și nu mai e nevoie să adunăm nimic ca să sortăm.
- evidența intrărilor ține **o singură** hartă mare. A doua, cu ultima zi în
  care fiecare adresă a fost văzută, ar fi dublat consumul pentru o informație
  necesară doar la adresele dispărute, adică la câteva sute.

Vârf măsurat: 286 MB în timpul analizei, 77 MB pentru server în repaus.
Prețul plătit: o cerere la `/api/jobs` parcurge fișierul, deci durează
secunde, nu milisecunde.

## De unde vine fiecare verdict

O regulă trebuie să poată spune de unde știe. Trei care au fost corectate
pentru că nu puteau:

**Statusul companiei** vine din `company.status` din catalog, care vine din
`anafData.statusImpozit`, adus de la ANAF de scraperul `inviitor-ro`. Noi nu
verificăm nimic. Deci: regula se numește „inactivă fiscal la ANAF”, nu „nu mai
e activă”; trage doar pe `inactiv`, `suspendat`, `radiat`; iar `funcțiune`
(= în funcțiune, adică activă) și statusul gol au ieșit din ea și au devenit o
regulă de format. În sertar apare data la care catalogul a întrebat ultima dată.

**Duplicatele nu mai sunt o neconformitate.** `url` este cheia unică a
core-ului Solr, deci două documente nu pot avea aceeași adresă: zero duplicate
exacte, prin construcție. Repetarea (titlu, companie și localitate identice sub
adrese diferite) rămâne măsurată la Abateri de format, dar necontabilizată.

**Conținutul pentru adulți** nu poate fi o listă simplă de cuvinte:
„animatoare zile naștere copii” și „Webchat non-adult” ieșeau ca joburi de
adulți. Acum sunt trei niveluri: cuvinte tari care trag singure, cuvinte
generice anulate de o negație, și cuvinte slabe care trag doar în pereche sau
lângă un club. Contextul de petrecere pentru copii le anulează.

## Lucruri învățate din versiunea anterioară (peviitor-doctor)

- Un plafon pe un colector urmat de o sortare e un prefix sortat, nu un top-N. Sortează, apoi taie.
- `title` și `location` sunt `text_general`: un facet pe ele întoarce fragmente de cuvinte. De aceea scanăm tot indexul și grupăm în JS.
- `.dockerignore` poate ascunde un fișier de care ai nevoie. `data/` se livrează integral.
- Sortarea după număr ascunde lucrurile grave și rare. 61 de anunțuri de videochat ajungeau sub 13.000 de titluri cu majuscule. Prima pagină arată toate regulile grave care au tras, nu primele opt.
- Nu inventa date. Un CIF inventat la testare a ajuns odată pe ecran. Și harta județelor din repo-ul vechi era inventată: Brașov avea 4 puncte.
- O verificare pe care o măsoară un model e "nemăsurată" ori de câte ori modelul lipsește. O regulă deterministă bate una care e uneori acolo.
