# BAROMETRU — cum ar trebui să funcționeze produsul

Research făcut pe 5 septembrie 2026. Surse la final.

## Ce spune lumea care face asta de zece ani

Trei surse independente spun același lucru despre agregatoarele de joburi:

| sursa | ce pedepsește / ce contează |
|---|---|
| **Google for Jobs** (politica editorială) | anunțuri **expirate**, **duplicate** fără canonical, informații **înșelătoare** (locație, salariu, dată falsificată ca să pară nou), anunțuri **false** (reclame deghizate, scam), fără mod de aplicare, limbaj vulgar |
| **Indeed** (standarde de calitate) | **duplicate**, conținut **înșelător sau neautentic** ("nu suntem convinși că e un job real"), titluri vagi, spam (ALL CAPS, punctuație) |
| **LinkUp** (poluarea datelor la agregatoare) | **fraudă** (phishing de date personale), **duplicate** din sindicalizare, **expirate** (jobul s-a ocupat în ziua 7, anunțul stă 30 de zile) |

Nicăieri nu apare „HTML în titlu” ca motiv de eliminare. Apare la Indeed, la coada listei, sub „spam-like content”, lângă ALL CAPS. E cosmetic.

Cadrul standard de calitate a datelor (DAMA) are șase dimensiuni: completitudine, acuratețe, consistență, actualitate, unicitate, validitate. Pentru un agregator de joburi, trei dintre ele sunt cele care dor: **actualitate** (mai există jobul?), **unicitate** (e o dată sau de zece ori?), **acuratețe** (spune adevărul?). Celelalte trei (completitudine, validitate, consistență) sunt treaba scraperelor și a contractului, nu a cititorului.

Produsele de data observability (Monte Carlo, Soda) adaugă două lucruri pe care le lipseau versiunile anterioare: fiecare problemă are un **proprietar** (cine o repară) și un **trend** (azi față de ieri). Un număr fără trend nu spune dacă merge mai bine sau mai rău.

## Modelul: trei întrebări despre fiecare anunț

Nu 41 de reguli pe același ecran. Trei întrebări, în ordinea în care dor:

### 1. Mai există jobul?
Cititorul dă click și pagina nu mai e, sau firma nu mai e.
- link mort (404 / 410) — măsurat pe eșantion, raportat ca estimare per site
- companie inactivă, suspendată, radiată (contractul spune: șterge compania și joburile ei)
- anunț în status `scraped` de peste 30 de zile, nevalidat de nimeni
- anunț mai vechi de 90 de zile

### 2. E unic?
Același post apare de 1.386 de ori sub 1.386 de URL-uri. Cititorul vede o pagină întreagă de același job.
- același titlu + aceeași companie sub alt URL (prima apariție nu se numără, doar copiile)

### 3. Spune adevărul?
Cititorul caută „Cluj” și primește Amsterdam, sau un CIF care nu e al nimănui, sau un anunț de videochat.
- locație în afara României, locație inventată, „Romania” / „Remote” fără oraș, fără locație
- CIF invalid, CIF fără companie în catalog, fără CIF, fără companie
- conținut adult, date personale (telefon, email, CNP) în titlu
- fără titlu, titlu inutilizabil

Un anunț care trece toate trei e un **anunț de încredere**. Cifra unică a produsului: *câte anunțuri din index sunt de încredere*. Nu „scor”, nu procent pe grupuri.

### 4. E bine format? (pagină separată, pentru cine scrie scrapere)
Tot ce e încălcare de contract fără efect pentru cititor: HTML în titlu, majuscule, spații, etichete cu diacritice, `workmode` necunoscut, status în afara fluxului, dată lipsă, salariu în alt format, nume companie diferit de catalog, CIF cu prefix RO. Utile, dar la „Pentru scrapere”, nu pe prima pagină.

## Cine repară: proprietarul fiecărei probleme

| problema | proprietar | de ce |
|---|---|---|
| link mort, expirat, vechi | **peviitor_core** | are deja job zilnic de revalidare la 06:00; dacă tot avem linkuri moarte, jobul ăla nu merge |
| companie inactivă | **peviitor_core** | contractul spune „șterge compania și joburile ei” |
| duplicate | **scraperul** (dacă vin de pe un singur site) sau **core** (dacă același job vine de pe două site-uri) | se vede din pagina Surse |
| locație greșită, CIF greșit, adult, date personale, format | **scraperul** sursei | fiecare hostname = un repo `Scrapers_*` în organizație |

Pagina **Surse** e deci pagina de proprietari: per site, câte anunțuri „nu mai există”, câte sunt duplicate, câte mint, câte sunt prost formate. Un site cu 95% duplicate are un scraper stricat, nu 20.000 de probleme.

## Trend

Fiecare rulare zilnică se păstrează (agregatele, ~200 KB). Prima pagină arată azi față de acum 7 zile: „anunțuri de încredere: 42.100 (+1.200 față de săptămâna trecută)”. Fără trend nu știi dacă un fix la scraper a ajutat.

## Cifre: o singură formă

Peste tot: **„N din M”**. „4.519 din 87.661 de anunțuri”. Un procent apare într-un singur loc: pe pagina Surse, per site, pentru că acolo comparația între site-uri de mărimi diferite cere procent („80% din anunțurile de pe iajob.ro sunt duplicate”).

## Statistici (harta, companii, ocupații)

Rămân, dar se calculează pe **anunțurile de încredere**, nu pe tot indexul. O hartă care numără și duplicatele și cele moarte arată de 2 ori mai multe joburi decât există. Lângă fiecare grafic: „din N anunțuri de încredere”.

## Ce se schimbă față de ce e construit acum

Motorul (scanare, îmbogățire, 41 de verificări, statistici, server, sertar) rămâne. Se schimbă:

1. Verificările se regrupează în cele 4 întrebări; „grav” = întrebările 1–3, „format” = întrebarea 4.
2. Prima pagină: trei numere + „anunțuri de încredere” + trend. Fără scor, fără procente pe grupuri.
3. Pagina Probleme devine două: **Probleme** (întrebările 1–3) și **Pentru scrapere** (întrebarea 4).
4. Surse: patru coloane fixe (nu mai există / duplicate / mint / format) + proprietar.
5. Statisticile pe anunțuri de încredere.
6. Istoric de rulări pentru trend.

## Surse

- Google for Jobs, politici de conținut și proprietăți obligatorii: https://developers.google.com/search/docs/appearance/structured-data/job-posting
- Google, actualizarea ghidului pentru anunțuri (expirate, date false): https://developers.google.com/search/blog/2018/04/we-updated-our-job-posting-guidelines
- Indeed, standarde de calitate: https://www.indeed.com/help/employers/articles/115005915763
- Indeed, de ce e marcat un anunț: https://www.indeed.com/hire/resources/howtohub/job-flagged-on-indeed
- LinkUp, poluarea datelor la job boards: https://www.linkup.com/insights/blog/job-board-data-pollution
- Ghost jobs, 2026: https://jobstrack.io/blog/ghost-jobs-2026
- DAMA, dimensiunile calității datelor: http://dama-nl.org/wp-content/uploads/2020/09/DDQ-Dimensions-of-Data-Quality-Research-Paper-version-1.2-d.d.-3-Sept-2020.pdf
- Soda, ghid dimensiuni: https://soda.io/blog/guide-to-data-quality-dimensions
- Monte Carlo vs Soda vs Great Expectations (severitate, proprietar, trend): https://www.modern-datatools.com/compare/monte-carlo-vs-great-expectations-vs-soda
