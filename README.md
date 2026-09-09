# BAROMETRU

Busola calității datelor pentru [peviitor.ro](https://peviitor.ro), motorul de
căutare de joburi open source. Citește indexul Solr de producție și spune ce e
în neregulă cu datele, cât, și din ce sursă vine.

**Găsește probleme. Nu le repară.** Clientul Solr nu are metode de scriere.

---

## Ce măsoară

Trei criterii despre fiecare anunț, în ordinea în care contează pentru cel care
caută un loc de muncă:

| criteriu | ce cuprinde | cine repară |
|---|---|---|
| **Disponibilitatea postului** | adresă inaccesibilă (404/410), adresă care întoarce eroare (4xx/5xx), companie declarată inactivă fiscal, nevalidat de peste 30 de zile | peviitor_core |
| **Corectitudinea datelor** | localitate din afara României sau nerecunoscută, CIF fără corespondent, conținut pentru adulți, date de contact personale, titlu în alt alfabet | scraperul sursei |
| **Abateri de format** | marcaje HTML, majuscule, etichete cu diacritice, status în afara fluxului, caractere corupte | scraperul sursei |

Un anunț care trece primele două criterii este **valid**. Câte anunțuri sunt
valide din câte există: asta e singura cifră a produsului. Fără scor, fără
procente pe grupuri.

Sunt 47 de verificări. Fiecare citează clauza din contractul
[peviitor_core](https://github.com/peviitor-ro/peviitor_core) pe care o aplică,
arată valori reale din date, și spune ce trebuie schimbat ca să nu se mai
întâmple.

## Ecrane

- **Sinteză** — anunțuri valide, ce a intrat în ultimele 10 zile, evoluția
- **Neconformități** — regulile grupate pe criterii, cu exemple și instrucțiuni
- **Scrapere** — o fișă per site, cu problemele lui și ce e de corectat
- **Surse** — tabel de comparație între toate site-urile
- **Hartă** — repartizarea pe județe, plus ce nu s-a putut plasa și de ce
- **Companii și ocupații** — cine publică, ce posturi se caută
- **Abateri de format** — încălcări de contract fără efect vizibil

Orice cifră se deschide și arată anunțurile din spatele ei.

## Cum se rulează

```bash
cp .env.example .env     # completează SOLR_PASS
npm test                 # offline: locații, CIF, fiecare verificare
npm run analiza          # analiza (--no-links refolosește sonda anterioară)
npm run server           # interfața, pe http://localhost:7777
```

Fără dependențe npm. Node 20 sau mai nou.

## Unde rulează

Analiza și afișajul stau separat, din cauza discului.

**Analiza** rulează într-un GitHub Action, noaptea. Evidența intrărilor și
istoricul evoluției trăiesc în cache-ul Actions. Rezultatul se publică la
release-ul `analiza`, mereu același, înlocuit la fiecare rulare.

**Afișajul** rulează pe o găzduire gratuită, cu `ANALIZA=off`. La pornire aduce
rezultatul din release. Nu calculează nimic și nu are nevoie de acces la Solr.

Motivul: pe planul gratuit discul se șterge la fiecare repornire și adormire,
deci evidența intrărilor nu ar supraviețui acolo.

Un singur secret, `SOLR_PASS`, ca secret de repo pentru Action.

## Documentație

- [CLAUDE.md](CLAUDE.md) — cum funcționează, ce a fost învățat pe parcurs
- [PRODUS.md](PRODUS.md) — de ce arată așa, cu research-ul din spate
- [RESEARCH-AI.md](RESEARCH-AI.md) — unde ar avea sens un model, și unde nu

Versiunea anterioară a proiectului este la eticheta `v1-peviitor-doctor`.
