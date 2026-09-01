# Prompt pentru Gemini — interfața BAROMETRU

Copiază tot ce e mai jos, de la linia cu `---`, într-o singură conversație cu Gemini.

---

Construiește interfața web pentru **BAROMETRU**, un instrument care măsoară calitatea datelor din motorul de căutare de joburi românesc **peviitor.ro**.

## Ce face aplicația

Verifică 76.000 de anunțuri de joburi reale față de un set de reguli și raportează ce e în neregulă. **Găsește probleme, nu le repară** — nu propune niciodată corecturi, nu are butoane de „repară", nu modifică datele. E un barometru: arată starea, atât.

Publicul: oamenii care întrețin peviitor.ro, voluntari cu puțin timp. Trebuie să deschidă pagina și în zece secunde să știe ce e stricat și unde.

## Reguli tehnice, obligatorii

- **HTML + CSS + JavaScript simplu.** Fără React, fără Vue, fără pas de build, fără TypeScript. Se servesc trei fișiere: `index.html`, `app.js`, `style.css`.
- **Fără CDN.** Nicio resursă externă. Dacă vrei o bibliotecă de grafice, presupune că `Chart.js 4.4` există deja local la `vendor/chart.umd.min.js` și e încărcată înaintea scriptului tău — `window.Chart` e disponibil.
- **Tot textul în română, cu diacritice corecte**: ă â î ș ț.
- **Temă întunecată implicit**, cu comutator spre temă deschisă. Culorile se definesc ca variabile CSS pe `:root`, iar tema deschisă le rescrie pe `:root[data-theme="light"]`.
- Responsiv: trebuie să arate bine la 1280px și la 375px.
- Accesibil: orice element pe care se dă click are `role="button"`, `tabindex="0"` și răspunde la Enter și Space. Focus vizibil pe tot.

## Direcția vizuală

**Jucăuș și cartoonish, dar nu copilăresc.** Gândește-te la un instrument de măsură prietenos, nu la un tablou de bord corporatist.

- colțuri foarte rotunjite (14–16px), borduri groase (2px), umbre moi
- butoane pastilă care se ridică ușor la hover și se afundă la click
- animații pe arc elastic: `cubic-bezier(.34, 1.56, .64, 1)`
- totul se mișcă puțin când interacționezi — carduri care se ridică, rânduri care alunecă lateral
- cifrele mari sunt eroii paginii, scrise cu font monospațiat
- fără gradienți agresivi, fără neon; culorile sunt calme, formele sunt jucăușe

## Elementul central: TERMOMETRUL

Piesa de rezistență a paginii principale. Un termometru desenat în CSS, vertical:

- tub cu mercur care **urcă animat** de la 0 la scorul real când se încarcă pagina (~1 secundă, cu arc elastic)
- bulb rotund la bază, care luminează (`box-shadow`) în culoarea zonei
- scală gradată alături: 0, 25, 50, 75, 100
- verde peste 80, portocaliu între 55 și 80, roșu sub 55
- lângă el, scorul uriaș (`72/100`) și un cuvânt: „sănătoasă", „acceptabilă", „cu probleme"
- sub el, lista **„Ce trage în jos"** — primele trei probleme, fiecare clicabilă

## Principiul care contează cel mai mult

**Orice cifră afișată se poate apăsa și deschide joburile reale din spatele ei.**

Fără excepție: o cifră din card, o bară de grafic, o felie de inel, un rând din legendă. Toate deschid același sertar lateral (drawer) cu tabelul de joburi. Un număr pe care nu poți da click e un număr mort.

Sertarul: intră glisând din dreapta, are fundal întunecat peste pagină, se închide cu Escape sau click în afară, ține focusul înăuntru cât e deschis.

## Ecranele

### 1. Triaj (principal)
- termometrul cu scorul
- un **buletin** scris de AI (text în markdown simplu — randează `**bold**`), primit gata scris de la API
- carduri mari cu cifrele-cheie, clicabile
- inel (doughnut) cu distribuția locațiilor, feliile clicabile
- lista de reguli grupate, ordonate după gravitate, fiecare cu numărul ei și o săgeată

### 2. Locații
grafic cu bare orizontale — cele mai multe joburi pe localitate. Apeși o bară, primești joburile.

### 3. Companii
la fel, pe companii.

### 4. Surse
**Cel mai important ecran după Triaj.** Arată din ce site provin datele stricate. Pentru fiecare sursă: numele domeniului, un procent colorat (cât din joburile ei sunt afectate), câte joburi, o propoziție de diagnostic, și etichete-pastilă pentru fiecare tip de problemă — fiecare eticheta clicabilă.

### 5. Ocupații (COR)
cât din joburi se potrivesc cu clasificarea oficială a ocupațiilor din România.

## API-ul — formele exacte

Serverul rulează pe același host. **Citește exact cheile astea, nu ghici alte nume.** Dacă o cheie lipsește, afișează o eroare vizibilă — nu pune zero, nu inventa date.

### `GET /api/checks`
```json
{
  "total": 76353,
  "score": 72,
  "measured": 26,
  "totalRules": 26,
  "scannedAt": "2026-08-31T12:00:00.000Z",
  "groups": [{ "name": "Locații", "items": [ /* aceleași obiecte ca în rules */ ] }],
  "rules": [{
    "id": "loc_junk",
    "label": "Locații care nu sunt locuri",
    "hint": "Valori ca „all”, „Nespecificat”...",
    "group": "Locații",
    "severity": "blocant",
    "weight": 12,
    "count": 251,
    "measured": true,
    "pct": 0.33
  }]
}
```
`severity` are patru valori: `blocant` (grav, roșu), `avertisment` (portocaliu), `info` (albastru), `cosmetic` (gri, nu contează).

### `GET /api/jobs?issue=<id>&offset=0&limit=50`
```json
{
  "issue": "loc_junk",
  "label": "Locații care nu sunt locuri",
  "total": 251,
  "offset": 0,
  "limit": 50,
  "rows": [{
    "url": "https://...",
    "title": "AR Disputes Specialist with Lithuanian",
    "company": "DELOITTE TAX SRL",
    "cif": "22915705",
    "location": ["all, Romania"],
    "locKind": "junk",
    "locHow": "not-a-place",
    "workmode": "remote",
    "salary": null,
    "date": "2026-08-30T13:38:25.909Z",
    "status": "scraped"
  }]
}
```
Acceptă și `?company=<nume exact>` sau `?loc=<localitate>` în loc de `issue`.

### `GET /api/top?field=location|company|loc_kind&limit=15`
```json
{ "field": "location", "items": [{ "value": "București", "count": 22572 }] }
```
Pentru `loc_kind`, valorile sunt: `fixed` (localitate identificată, verde), `country` (doar nivel de țară, albastru — **corect pentru joburi remote, nu e defect**), `international` (portocaliu), `junk` (nu e un loc, roșu).

### `GET /api/summary`
```json
{ "ok": true, "text": "**Pe scurt** — ...", "at": "...", "tokens": { "input": 2997, "output": 732 } }
```
Text în markdown cu secțiuni îngroșate. Randează doar `**bold**` și paragrafele. Are și `GET /api/summary?force=1` pentru regenerare.

### `GET /api/sources`
```json
{
  "diagnosedBy": "gemini/gemini-flash-lite-latest",
  "rows": [{
    "host": "jobviewtrack.com",
    "jobs": 15208,
    "affected": 14331,
    "affectedPct": 94.2,
    "diagnostic": "Sursa generează un număr masiv de joburi duplicate...",
    "top": [{ "id": "dup_title_company", "label": "Joburi duplicate", "severity": "avertisment", "n": 14239, "pct": 93.6 }]
  }]
}
```

### `GET /api/occupations`
```json
{ "jobs": 76353, "distinctTitles": 33241, "matchedJobs": 42571, "matchedPct": 59.24,
  "topOccupations": [{ "code": "833201", "name": "conducător auto...", "count": 1972 }],
  "unmatchedTitles": [{ "title": "Senior Project Manager", "count": 475 }] }
```

### `POST /api/pipeline` cu `{"confirm": true}`
Repornește analiza. Urmărește progresul cu `GET /api/pipeline/status`, care întoarce `{ running, step, seconds, exitCode, lines: [] }`. Afișează `lines` într-o consolă cu fundal foarte închis (`#05070a`), font monospațiat, care se derulează singură.

## Ce să NU faci

- **Nu inventa niciodată date.** Fără rânduri de exemplu, fără valori de umplutură, fără „lorem ipsum". Dacă un apel eșuează, arată eroarea. Proprietarul a pierdut încrederea într-o versiune anterioară fiindcă avea date fabricate care păreau reale.
- Nu ghici numele cheilor din JSON. O versiune veche folosea `pick(obj, ["a","b","c"])` cu revenire tăcută pe `0`, și patru ecrane afișau zerouri peste date perfect sănătoase.
- Nu scrie niciodată în CSS o culoare direct din JavaScript prin `style.background = "var(--ceva)"`. O variabilă CSS inexistentă eșuează tăcut și elementul devine invizibil. Aplică întotdeauna clase.
- Fără text explicativ despre cum funcționează aplicația pe dinăuntru, fără note despre ce model AI face ce. Interfața vorbește despre date, nu despre ea însăși.
- Fără jargon: nu folosi „blocant", „severitate", „registru", „materializat", „scor compozit". Scrie „grav", „problemă", „verificare".

## Livrabil

Trei fișiere complete și funcționale: `index.html`, `app.js`, `style.css`. Cod comentat doar unde alegerea nu e evidentă. Numele aplicației e **BAROMETRU**, subtitlul „starea datelor · peviitor.ro", iar emblema e un termometru 🌡 într-un pătrat rotunjit.
