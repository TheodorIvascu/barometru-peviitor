"use strict";
/**
 * The checks catalog. This file IS the product: one row per thing that can be
 * wrong with a job, each citing the peviitor_core clause it enforces.
 *
 * A check is a pure predicate over an enriched job (see enrich.js). Its count
 * is the number of jobs where the predicate holds; its rows are those same
 * jobs. Nothing else computes a number, so a count can never disagree with
 * the list behind it.
 *
 * severity   grav    the reader is misled: a dead, duplicate, foreign, adult or unplaceable job,
 *                    or one tied to a company that does not exist or is not active
 *            minor   the contract is violated but nobody notices on the site
 *            info    measured and shown, never counted
 *
 * dimension  the group the UI shows the check under
 */
const { cifChecksumOk, cifIsContractShape, cifHasRoPrefix } = require("./cif.js");

const WORKMODES = new Set(["remote", "on-site", "hybrid"]);
const STATUSES = new Set(["scraped", "tested", "verified", "published"]);
const COMPANY_STATUSES = new Set(["activ", "suspendat", "inactiv", "radiat"]);
const NOT_ACTIVE = new Set(["suspendat", "inactiv", "radiat"]);
const HTML_TAG = /<\/?[a-z][^>]*>/i;
const HTML_ENT = /&(amp|quot|lt|gt|nbsp|apos|#\d+|#x[0-9a-f]+);/i;
// UTF-8 bytes decoded as latin-1 on the way in: an en dash arrives as "â€“",
// "ș" as "È™". The title stays searchable only by accident, and looks broken on screen.
// mathematical bold/italic, fullwidth and circled letters used to make a listing stand out
/**
 * Which alphabet a title is written in. Two different defects hide here:
 *   mostly non-latin  the job is written in another language and nobody
 *                     searching in Romanian will ever ask for those words
 *   a few non-latin   homoglyphs: the Cyrillic "\u0430" and "\u0435" are drawn exactly like
 *                     "a" and "e", so "R\u0430diologie" looks right on screen and a
 *                     search for "Radiologie" returns nothing
 * Between the two sits the honest bilingual title ("Bulgara/\u0411\u044a\u043b\u0433\u0430\u0440\u0441\u043a\u0438"),
 * which is left alone.
 */
function latinShare(title) {
  const t = String(title).normalize("NFKC");
  const all = (t.match(/\p{L}/gu) || []).length;
  if (all < 3) return 1;
  return (t.match(/\p{Script=Latin}/gu) || []).length / all;
}

const FANCY_LETTERS = /[\u{1D400}-\u{1D7FF}\u{FF21}-\u{FF5A}\u{2460}-\u{24FF}]/u;
const MOJIBAKE = /(â€|Ã[¢©ª«¨ƒ]|Å[£¾]|Äƒ|È[™›]|Â[«»°ª ])/;
const DIACRITICS = /[ăâîșțşţĂÂÎȘȚŞŢ]/;
/**
 * Adult content, in three tiers. A single word list produced false positives
 * on real jobs: "animatoare zile nastere copii" is a children's entertainer,
 * and "Webchat non-adult" says so in its own title.
 *   strong   fires on its own
 *   generic  fires on its own unless the title negates it
 *   weak     fires only when two appear together, or one plus a club
 */
const ADULT_STRONG = /\b(videochat|video\s*chat|onlyfans|only\s*fans|escort[aăe]?|masaj\s+(erotic|senzual)|striptease|strip\s*club|cam\s*girl|webcam\s*(model|studio))\b/i;
const ADULT_GENERIC = /\b(adult\s*(industry|content|entertainment)|(industri[ae]|con[țt]inut|filme)\s+pentru\s+adul[țt]i|xxx)\b/i;
const ADULT_NEGATION = /\bnon[-\s]?adult\b/i;
const ADULT_CLUB = /\b(night\s*club|club\s*de\s*noapte|passion\s*club|hostess\s*club)\b/i;
const ADULT_KIDS = /(copii|zile\s*na[sș]tere|anivers[aă]r|mascot|botez|petreceri\s+pentru\s+copii|gr[aă]dini[tț])/i;
const ADULT_WEAK = [/\bdansatoare\b/i, /\banimatoare\b/i, /\bhostess\b/i, /\bmasaj\b/i];
function looksAdult(title) {
  if (ADULT_STRONG.test(title)) return true;
  if (ADULT_GENERIC.test(title) && !ADULT_NEGATION.test(title)) return true;
  const weak = ADULT_WEAK.filter((re) => re.test(title)).length;
  if (ADULT_KIDS.test(title)) return false;   // „animatoare zile naștere copii” is a party entertainer
  return weak >= 2 || (weak >= 1 && ADULT_CLUB.test(title));
}
// a Romanian number: mobile 07xx, landline 02xx/03xx, with or without +40
const PHONE = /(?:^|[^\d])(?:(?:\+?40|0040)[\s.-]?|0)(?:7\d{2}|[23]\d{2})[\s.().-]?\d{3}[\s.().-]?\d{3}(?!\d)/;
// a lowercase local part: people write "contact@", job boards write "Specialist@Flip.ro"
const EMAIL = /(?:^|[^A-Za-z0-9._%+-])[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+\.[a-z]{2,}/;
const CNP = /\b[1-8]\d{12}\b/;
const SALARY = /^\d+(\.\d+)?-\d+(\.\d+)?\s+[A-Z]{3}$/;
const CONTACT_FIELDS = (e) => [e.title, e.company, e.location.join(" "), e.tags.join(" ")];

const letters = (s) => String(s).normalize("NFKC").replace(/[^\p{L}]/gu, "");

const CHECKS = [
  // ---- Câmpuri goale -----------------------------------------------------
  { id: "missing_title", dimension: "Corectitudinea datelor", severity: "grav", owner: "scraper",
    label: "Titlu necompletat", why: "Anunțul nu poate fi indexat și nu poate fi afișat în rezultatele căutării.",
    contract: "Job.title: string, required",
    test: (e) => !e.title.trim() },
  { id: "missing_company", dimension: "Corectitudinea datelor", severity: "grav", owner: "scraper",
    label: "Companie necompletată", why: "Anunțul nu poate fi asociat unui angajator.",
    contract: "Job.company: legal full name",
    test: (e) => !e.company.trim() },
  { id: "missing_cif", dimension: "Corectitudinea datelor", severity: "grav", owner: "scraper",
    label: "CIF necompletat", why: "Anunțul nu poate fi asociat unei companii din catalog.",
    contract: "Job.cif: string; Company.id = CIF",
    test: (e) => !e.cif.trim() },
  { id: "missing_location", dimension: "Corectitudinea datelor", severity: "grav", owner: "scraper",
    label: "Locație necompletată", why: "Anunțul nu apare în căutările după localitate.",
    contract: "Job.location: string[], Romanian cities",
    test: (e) => e.location.length === 0 || e.location.every((l) => !String(l).trim()) },
  { id: "missing_date", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Dată necompletată", why: "Vechimea anunțului nu poate fi determinată.",
    contract: "Job.date: UTC ISO8601 of scrape",
    test: (e) => !e.date },
  { id: "missing_workmode", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Mod de lucru necompletat", why: "Anunțul nu apare la filtrarea după remote, hibrid sau la sediu.",
    contract: "Job.workmode: remote | on-site | hybrid",
    test: (e) => !e.workmode },
  { id: "missing_tags", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Etichete necompletate", why: "Anunțul nu apare în navigarea pe categorii.",
    contract: "Job.tags: string[]",
    test: (e) => e.tags.length === 0 },
  { id: "missing_salary", dimension: "Abateri de format", severity: "info", owner: "scraper",
    label: "Salariu necompletat", why: "Câmp opțional. Este măsurat, dar nu este contabilizat ca neconformitate.",
    contract: "Job.salary: \"MIN-MAX CURRENCY\"",
    test: (e) => e.salary === "" || (Array.isArray(e.salary) && e.salary.length === 0) },

  // ---- Schemă --------------------------------------------------------------
  { id: "url_invalid", dimension: "Corectitudinea datelor", severity: "grav", owner: "scraper",
    label: "Adresă URL invalidă", why: "Identificatorul unic al documentului nu este o adresă HTTP sau HTTPS validă.",
    contract: "Job.url: valid HTTP/HTTPS, unique",
    test: (e) => { try { const u = new URL(e.url); return u.protocol !== "http:" && u.protocol !== "https:"; } catch { return true; } } },
  { id: "title_too_long", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Titlu care depășește 200 de caractere", why: "Depășește lungimea maximă prevăzută în contractul de date.",
    contract: "Job.title: max 200 chars",
    test: (e) => e.title.length > 200 },
  { id: "title_html", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Marcaje HTML în titlu", why: "Etichete sau entități HTML rămase din pagina sursă, afișate ca atare în interfață.",
    contract: "Job.title: no HTML",
    test: (e) => HTML_TAG.test(e.title) || HTML_ENT.test(e.title) },
  { id: "title_untrimmed", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Spații redundante în titlu", why: "Spații la începutul sau sfârșitul textului, ori spații duble între cuvinte.",
    contract: "Job.title: trimmed",
    test: (e) => e.title !== e.title.trim() || /\s{2,}/.test(e.title) },
  { id: "company_not_uppercase", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Denumire de companie fără majuscule", why: "Contractul prevede scrierea integrală cu majuscule a denumirii legale.",
    contract: "Job.company: always UPPERCASE",
    test: (e) => !!e.company && e.company !== e.company.toLocaleUpperCase("ro") },
  { id: "company_html", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Marcaje HTML în denumirea companiei", why: "Entități HTML nedecodate în denumirea legală.",
    contract: "Job.company: legal full name",
    test: (e) => HTML_TAG.test(e.company) || HTML_ENT.test(e.company) },
  { id: "tags_diacritics", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Etichete cu diacritice", why: "Etichetele constituie chei de căutare și se scriu fără diacritice.",
    contract: "Job.tags: NO diacritics",
    test: (e) => e.tags.some((t) => DIACRITICS.test(t)) },
  { id: "tags_not_lowercase", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Etichete cu majuscule", why: "Contractul prevede scrierea etichetelor cu litere mici.",
    contract: "Job.tags: lowercase",
    test: (e) => e.tags.some((t) => t !== t.toLowerCase()) },
  { id: "tags_too_many", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Număr de etichete peste limită", why: "Contractul prevede maximum 20 de etichete.",
    contract: "Job.tags: max 20",
    test: (e) => e.tags.length > 20 },
  { id: "workmode_invalid", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Valoare nepermisă pentru modul de lucru", why: "Contractul permite exclusiv valorile remote, on-site și hybrid.",
    contract: "Job.workmode: only remote | on-site | hybrid",
    test: (e) => !!e.workmode && !WORKMODES.has(e.workmode) },
  { id: "status_invalid", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Status în afara fluxului definit", why: "Contractul permite exclusiv valorile scraped, tested, verified și published.",
    contract: "Job.status: scraped -> tested | verified -> published",
    test: (e) => !STATUSES.has(e.status) },
  { id: "title_other_alphabet", dimension: "Corectitudinea datelor", severity: "grav", owner: "scraper",
    label: "Titlu redactat în alt alfabet",
    why: "Anunțul este redactat în altă limbă și alt alfabet. Nu poate fi găsit prin căutare în limba română și nu poate fi citit de utilizatori.",
    contract: "peviitor.ro editorial rule",
    test: (e) => latinShare(e.title) < 0.5 },
  { id: "title_mixed_alphabets", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Caractere din alt alfabet inserate în cuvinte",
    why: "Caractere chirilice identice vizual cu cele latine, inserate în cuvinte. Titlul pare corect, însă căutarea după forma normală a cuvântului nu returnează anunțul.",
    contract: "Job.title: string",
    test: (e) => { const r = latinShare(e.title); return r >= 0.85 && r < 1; } },
  { id: "title_fancy_letters", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Titlu cu caractere decorative",
    why: "Caractere Unicode stilizate în locul literelor obișnuite. Anunțul se afișează corect, dar nu poate fi găsit prin căutare.",
    contract: "Job.title: string",
    test: (e) => FANCY_LETTERS.test(e.title) },
  { id: "text_mojibake", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Caractere corupte în titlu",
    why: "Text preluat cu o codificare incorectă la extragere. Caracterele speciale apar deformate.",
    contract: "Job.title: string, diacritics accepted (UTF-8)",
    test: (e) => MOJIBAKE.test(e.title) || MOJIBAKE.test(e.company) },
  { id: "company_status_invalid", dimension: "Abateri de format", severity: "minor", owner: "core",
    label: "Status de companie în afara contractului",
    why: "Catalogul conține valorile funcțiune și lichidare, nepermise de contract. Pe baza lor nu se poate stabili dacă firma își desfășoară activitatea.",
    contract: "Company.status: only activ | suspendat | inactiv | radiat",
    test: (e) => !!e.co && !COMPANY_STATUSES.has(e.co.status) },
  { id: "date_invalid", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Dată invalidă sau ulterioară analizei", why: "Valoarea nu respectă formatul ISO 8601 sau este ulterioară momentului analizei.",
    contract: "Job.date: UTC ISO8601 of scrape",
    test: (e, ctx) => { if (!e.date) return false; const t = Date.parse(e.date); return Number.isNaN(t) || t > ctx.now + 86400000; } },
  { id: "vdate_while_scraped", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Dată de validare pe un anunț nevalidat", why: "Câmpul vdate se completează numai la trecerea în statusul tested sau verified.",
    contract: "Job.vdate: set only when status becomes tested/verified",
    test: (e) => !!e.vdate && e.status === "scraped" },
  { id: "expiration_too_far", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Termen de expirare peste limita contractuală", why: "Anunțul ar rămâne în index peste termenul de 30 de zile prevăzut.",
    contract: "Job.expirationdate <= vdate + 30 days",
    test: (e) => { if (!e.vdate || !e.expirationdate) return false; const v = Date.parse(e.vdate), x = Date.parse(e.expirationdate); return !Number.isNaN(v) && !Number.isNaN(x) && x > v + 30 * 86400000; } },
  { id: "salary_bad_format", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Format incorect pentru salariu", why: "Contractul prevede un singur șir de forma \"MIN-MAX MONEDĂ\".",
    contract: "Job.salary: \"MIN-MAX CURRENCY\", string not array",
    test: (e) => { if (e.salary === "" || e.salary == null) return false; if (Array.isArray(e.salary)) return e.salary.length !== 1 || !SALARY.test(String(e.salary[0])); return !SALARY.test(String(e.salary)); } },

  // ---- Companii --------------------------------------------------------------
  { id: "cif_not_8_digits", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "CIF cu număr incorect de cifre", why: "Contractul prevede exact 8 cifre, fără prefix.",
    contract: "Company.id: 8 digits, no RO prefix",
    test: (e) => !!e.cif && !cifIsContractShape(e.cif) && !cifHasRoPrefix(e.cif) },
  { id: "cif_ro_prefix", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "CIF cu prefixul RO", why: "Prefixul RO nu face parte din identificatorul fiscal.",
    contract: "Company.id: no RO prefix",
    test: (e) => cifHasRoPrefix(e.cif) },
  { id: "cif_bad_checksum", dimension: "Corectitudinea datelor", severity: "grav", owner: "scraper",
    label: "CIF invalid (cifră de control)", why: "Valoarea nu poate corespunde niciunei firme. Indică o eroare de extragere.",
    contract: "Company.id: exact CIF/CUI",
    test: (e) => !!e.cif && !cifChecksumOk(e.cif) },
  { id: "cif_orphan", dimension: "Corectitudinea datelor", severity: "grav", owner: "scraper",
    label: "CIF fără corespondent în catalog", why: "Compania nu figurează în catalog, iar pagina acesteia nu poate fi afișată.",
    contract: "Job.cif must reference a Company",
    test: (e) => !!e.cif && !e.co },
  { id: "company_mismatch", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Denumire diferită față de catalog", why: "Anunțul și fișa companiei conțin denumiri diferite pentru același CIF.",
    contract: "Job.company must match Company.company (case-insensitive)",
    test: (e) => !!e.co && !!e.company && e.company.trim().toLowerCase() !== e.co.name.trim().toLowerCase() },
  { id: "company_not_active", dimension: "Disponibilitatea postului", severity: "grav", owner: "core",
    label: "Companie declarată inactivă fiscal",
    why: "Informație preluată din catalogul de companii, care înregistrează statusul comunicat de ANAF. Nu este verificată independent, poate avea o vechime de câteva săptămâni, iar inactivitatea fiscală nu echivalează cu radierea firmei.",
    contract: "Company.status != activ => remove the company and its jobs",
    test: (e) => !!e.co && NOT_ACTIVE.has(e.co.status) },

  // ---- Locații ----------------------------------------------------------------
  { id: "loc_gibberish", dimension: "Corectitudinea datelor", severity: "grav", owner: "scraper",
    label: "Localitate nerecunoscută", why: "Adresă fără localitate, cod intern sau text care nu desemnează un loc.",
    contract: "Job.location: Romanian cities/addresses",
    test: (e) => e.loc.kind === "junk" && (e.loc.how === "unrecognised" || e.loc.how === "not-a-place") },
  { id: "loc_placeholder", dimension: "Corectitudinea datelor", severity: "grav", owner: "scraper",
    label: "Locație generică", why: "Valori precum Romania, Remote sau Nespecificat nu indică localitatea postului.",
    contract: "Job.location: Romanian cities/addresses",
    test: (e) => e.loc.kind === "junk" && e.loc.how === "placeholder" },
  { id: "loc_foreign", dimension: "Corectitudinea datelor", severity: "grav", owner: "scraper",
    label: "Localitate din afara României", why: "Postul este localizat în afara ariei acoperite de platformă.",
    contract: "Job.location: Romanian cities/addresses",
    test: (e) => e.loc.kind === "international" },
  { id: "loc_county_unknown", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Localitate cu județ nedeterminat", why: "Denumirea există în mai multe județe, iar anunțul nu precizează județul.",
    contract: "Job.location: Romanian cities/addresses",
    test: (e) => e.loc.kind === "fixed" && !e.loc.county },

  // ---- Conținut -----------------------------------------------------------------
  { id: "title_adult", dimension: "Corectitudinea datelor", severity: "grav", owner: "scraper",
    label: "Conținut pentru adulți", why: "Anunțuri de tip videochat, escortă, masaj erotic și similare.",
    contract: "peviitor.ro editorial rule",
    test: (e) => looksAdult(e.title) },
  { id: "contact_in_ad", dimension: "Corectitudinea datelor", severity: "grav", owner: "scraper",
    label: "Date de contact în anunț",
    why: "Număr de telefon, adresă de e-mail sau CNP în titlu, în denumirea companiei, în locație sau în etichete. Datele sunt expuse public și eludează procedura de candidatură.",
    contract: "GDPR; Job.title is a title, Job.location is a place",
    test: (e) => CONTACT_FIELDS(e).some((v) => v && (PHONE.test(v) || EMAIL.test(v) || CNP.test(v))) },
  { id: "title_too_short", dimension: "Corectitudinea datelor", severity: "grav", owner: "scraper",
    label: "Titlu fără conținut lizibil", why: "Sub trei litere sau format exclusiv din cifre și semne de punctuație.",
    contract: "Job.title: string, required",
    test: (e) => !!e.title.trim() && letters(e.title).length < 3 },
  { id: "title_allcaps", dimension: "Abateri de format", severity: "minor", owner: "scraper",
    label: "Titlu scris integral cu majuscule", why: "Scriere neconformă cu regulile de prezentare ale platformei.",
    contract: "peviitor.ro presentation rule",
    test: (e) => { const l = letters(e.title); return l.length >= 6 && l === l.toLocaleUpperCase("ro") && l !== l.toLocaleLowerCase("ro"); } },
    { id: "repeated_listing", dimension: "Abateri de format", severity: "info", owner: "scraper",
    label: "Anunț repetat (titlu, companie și localitate identice)",
    why: "Măsurat, dar necontabilizat ca neconformitate: adresa URL diferă, deci pentru index sunt documente distincte. O valoare ridicată indică un scraper care republică același post sub adrese noi.",
    contract: "Job.url is the unique key; a different url is a different document",
    test: (e) => e.dupIndex > 0 },

  // ---- Prospețime ------------------------------------------------------------------
  { id: "stale_scraped", dimension: "Disponibilitatea postului", severity: "grav", owner: "core",
    label: "Nevalidat de peste 30 de zile", why: "Anunțul se află în statusul scraped de peste o lună, fără verificarea disponibilității postului.",
    contract: "Job.status: scraped -> tested | verified",
    test: (e) => e.status === "scraped" && e.age != null && e.age > 30 },
  { id: "very_old", dimension: "Disponibilitatea postului", severity: "grav", owner: "core",
    label: "Vechime de peste 90 de zile", why: "Anunț probabil expirat, indiferent de status.",
    contract: "Job.expirationdate <= vdate + 30 days",
    test: (e) => e.age != null && e.age > 90 },

  // ---- Linkuri (eșantion) ------------------------------------------------------------
  { id: "url_error", dimension: "Disponibilitatea postului", severity: "grav", owner: "core",
    label: "Adresă care întoarce eroare (4xx/5xx)",
    why: "Pagina răspunde cu 403, 500, 503 sau alt cod de eroare. Anunțul poate exista, dar cititorul nu ajunge la el. Verificare pe eșantion de adrese pentru fiecare sursă.",
    contract: "Job.url: canonical detail page",
    test: (e) => e.link === "error" },
  { id: "url_dead", dimension: "Disponibilitatea postului", severity: "grav", owner: "core",
    label: "Adresă inaccesibilă (404/410)", why: "Pagina anunțului nu mai există. Verificare efectuată pe un eșantion de adrese pentru fiecare sursă, nu pe întregul index.",
    contract: "Job.url: canonical detail page; peviitor_core deletes 404 daily",
    test: (e) => e.link === "dead" },
];

/**
 * The four questions the UI asks about every job, in the order they hurt.
 * The first three decide whether a job is trustworthy; the fourth is for the
 * people who write scrapers.
 */
const QUESTIONS = [
  { id: "exista", label: "Disponibilitatea postului", short: "indisponibile",
    why: "Pagina anunțului nu mai poate fi accesată sau compania nu mai figurează ca activă.", owner: "peviitor_core" },
  { id: "adevar", label: "Corectitudinea datelor", short: "date incorecte",
    why: "Localitate din afara României sau nerecunoscută, CIF fără corespondent, conținut pentru adulți, date de contact personale.", owner: "scraper" },
  { id: "format", label: "Abateri de format", short: "format",
    why: "Abateri de la contract fără efect vizibil pentru utilizator: marcaje HTML, majuscule, etichete, status.", owner: "scraper" },
];
// "info" checks are measured and shown but never make a job fail a question
for (const q of QUESTIONS) q.checks = CHECKS.filter((c) => c.dimension === q.label && c.severity !== "info").map((c) => c.id);
const QUESTION_OF = new Map();
for (const q of QUESTIONS) for (const id of q.checks) QUESTION_OF.set(id, q.id);

/**
 * What to put on screen as evidence for each rule. A row that says
 * "3.262 locatii generice" tells; a row that shows "Romania", "Remote",
 * "Nespecificat" shows. Default: the title.
 */
const SHOW = {
  contact_in_ad: (e) => (CONTACT_FIELDS(e).find((v) => v && (PHONE.test(v) || EMAIL.test(v) || CNP.test(v))) || e.title),
  loc_placeholder: (e) => e.location.join(", "),
  loc_foreign: (e) => e.location.join(", "),
  loc_gibberish: (e) => e.location.join(", "),
  loc_county_unknown: (e) => e.loc.value + " (" + e.location.join(", ") + ")",
  missing_location: (e) => e.title,
  cif_bad_checksum: (e) => e.cif + "  " + e.company,
  cif_orphan: (e) => e.cif + "  " + e.company,
  cif_not_8_digits: (e) => e.cif + "  " + e.company,
  cif_ro_prefix: (e) => e.cif + "  " + e.company,
  missing_cif: (e) => e.company,
  company_not_active: (e) => e.company + "  \u2192 " + (e.co ? e.co.status : ""),
  company_status_invalid: (e) => e.company + "  \u2192 " + (e.co ? e.co.status : ""),
  company_mismatch: (e) => e.company + "  \u2260  " + (e.co ? e.co.name : ""),
  company_not_uppercase: (e) => e.company,
  company_html: (e) => e.company,
  url_dead: (e) => e.linkCode + "  " + e.url,
  url_error: (e) => e.linkCode + "  " + e.url,
  url_invalid: (e) => e.url,
  tags_diacritics: (e) => e.tags.join(", "),
  tags_not_lowercase: (e) => e.tags.join(", "),
  tags_too_many: (e) => e.tags.length + " etichete: " + e.tags.slice(0, 6).join(", ") + "\u2026",
  workmode_invalid: (e) => e.workmode,
  status_invalid: (e) => e.status,
  salary_bad_format: (e) => String(e.salary),
  date_invalid: (e) => e.date,
  missing_date: (e) => e.title,
  stale_scraped: (e) => e.title + "  \u2192 " + e.age + " zile",
  very_old: (e) => e.title + "  \u2192 " + e.age + " zile",
  repeated_listing: (e) => e.title + "  \u2192 " + (e.loc.value || e.location.join(", ")),
  title_untrimmed: (e) => JSON.stringify(e.title),
  vdate_while_scraped: (e) => e.title + "  vdate " + e.vdate,
  expiration_too_far: (e) => "vdate " + e.vdate + "  \u2192  expir\u0103 " + e.expirationdate,
};
/** the offending value, as a short string fit for a table cell */
function evidence(e) {
  const out = {};
  for (const id of e.issues) out[id] = String((SHOW[id] || ((x) => x.title))(e) || "").slice(0, 120);
  return out;
}

/** Ce trebuie schimbat, pentru fiecare regulă. Se afișează lângă regulă. */
const FIXES = {
  "missing_title": "Nu indexați anunțul dacă selectorul de titlu nu a întors nimic. Un rând fără titlu e mai rău decât un rând lipsă.",
  "missing_company": "Completați denumirea legală din pagina sursă sau din catalogul de companii, după CIF.",
  "missing_cif": "Rezolvați CIF-ul înainte de indexare, din pagina firmei sau din catalog după denumire.",
  "missing_location": "Extrageți localitatea din pagină. Dacă postul e integral remote, folosiți acest lucru explicit, nu un câmp gol.",
  "missing_date": "Setați data extragerii în format ISO 8601 UTC la fiecare rulare a scraperului.",
  "missing_workmode": "Deduceți modul de lucru din text și trimiteți una dintre valorile remote, on-site sau hybrid.",
  "missing_tags": "Generați etichete din titlu și din descriere, cu litere mici și fără diacritice.",
  "missing_salary": "Completați salariul acolo unde pagina sursă îl publică, în forma MIN-MAX MONEDĂ.",
  "url_invalid": "Construiți adresa absolut, cu schemă și gazdă. O cale relativă nu poate fi cheie unică.",
  "title_too_long": "Tăiați titlul la 200 de caractere sau extrageți doar denumirea postului, fără descriere.",
  "title_html": "Decodați entitățile HTML și eliminați etichetele înainte de indexare. În Node: decodarea entităților pe textul extras, nu pe HTML-ul brut.",
  "title_untrimmed": "Aplicați trim și colapsați spațiile multiple într-unul singur.",
  "company_not_uppercase": "Transformați denumirea legală integral cu majuscule, păstrând diacriticele.",
  "company_html": "Decodați entitățile HTML în denumirea companiei, la fel ca la titlu.",
  "tags_diacritics": "Eliminați diacriticele din etichete înainte de indexare. Titlul și locația le păstrează, etichetele nu.",
  "tags_not_lowercase": "Transformați etichetele cu litere mici.",
  "tags_too_many": "Păstrați cele mai relevante 20 de etichete și renunțați la rest.",
  "workmode_invalid": "Mapați valoarea proprie a sursei pe una dintre cele trei permise, înainte de indexare.",
  "status_invalid": "Trimiteți anunțurile nou extrase cu statusul scraped. Restul fluxului îl schimbă nucleul.",
  "company_status_invalid": "Normalizați statusul ANAF pe cele patru valori din contract la scrierea în catalogul de companii.",
  "date_invalid": "Verificați parsarea datei din pagina sursă și nu trimiteți date din viitor.",
  "vdate_while_scraped": "Nu completați vdate la extragere. Se setează doar când statusul devine tested sau verified.",
  "expiration_too_far": "Limitați termenul de expirare la cel mult 30 de zile de la data validării.",
  "salary_bad_format": "Formatați salariul ca un singur șir MIN-MAX MONEDĂ, de exemplu 3000-4500 RON.",
  "cif_not_8_digits": "Extrageți exact cele 8 cifre ale codului fiscal, fără spații și fără alte caractere.",
  "cif_ro_prefix": "Eliminați prefixul RO înainte de indexare.",
  "cif_bad_checksum": "Verificați cifra de control a CIF-ului la extragere și respingeți anunțul dacă nu trece.",
  "cif_orphan": "Adăugați compania în catalog înainte de a-i indexa anunțurile, sau nu indexați anunțul.",
  "company_mismatch": "Folosiți denumirea din catalog ca sursă unică, nu textul din pagina anunțului.",
  "company_not_active": "Verificarea aparține nucleului: contractul cere ștergerea companiei inactive și a anunțurilor ei.",
  "loc_gibberish": "Extrageți numele localității, nu linia de adresă completă și nu codul intern al sursei.",
  "loc_placeholder": "Nu trimiteți Romania, Remote sau Nespecificat ca localitate. Dacă postul e remote, folosiți câmpul workmode.",
  "loc_foreign": "Filtrați posturile din afara României înainte de indexare, sau marcați-le explicit.",
  "loc_county_unknown": "Adăugați județul lângă localitate atunci când numele există în mai multe județe.",
  "title_adult": "Excludeți din extragere categoriile de conținut pentru adulți ale sursei.",
  "contact_in_ad": "Eliminați numerele de telefon și adresele de e-mail din titlu, denumire, locație și etichete.",
  "title_too_short": "Respingeți anunțul dacă titlul extras nu conține cel puțin trei litere.",
  "title_allcaps": "Transformați titlurile scrise integral cu majuscule în scriere normală.",
  "title_other_alphabet": "Filtrați anunțurile redactate în alt alfabet, sau adăugați traducerea în română.",
  "title_mixed_alphabets": "Normalizați caracterele la alfabetul latin. Literele chirilice identice vizual strică regăsirea.",
  "title_fancy_letters": "Aplicați normalizare Unicode NFKC pe titlu înainte de indexare.",
  "text_mojibake": "Citiți pagina sursă cu codificarea corectă, de regulă UTF-8, în loc de codificarea implicită.",
  "url_error": "Verificați dacă adresa construită de scraper e cea corectă. Un 403 constant înseamnă că site-ul blochează accesul, un 500 că adresa e greșită sau pagina e stricată.",
  "url_dead": "Verificarea aparține nucleului: contractul cere ștergerea zilnică a anunțurilor care întorc 404.",
  "stale_scraped": "Verificarea aparține nucleului: revalidarea zilnică ar trebui să schimbe statusul sau să șteargă anunțul.",
  "very_old": "Verificarea aparține nucleului: anunțurile expirate ar trebui eliminate.",
  "repeated_listing": "Dacă sursa oferă un identificator stabil al postului, folosiți-l în adresă în locul unui parametru care se schimbă la fiecare extragere."
};
for (const c of CHECKS) c.fix = FIXES[c.id] || "";

const BY_ID = new Map(CHECKS.map((c) => [c.id, c]));
const SCORED = new Set(["grav"]);

/** run every check on one enriched job; returns the ids that fired */
function issuesOf(e, ctx) {
  const out = [];
  for (const c of CHECKS) if (c.test(e, ctx)) out.push(c.id);
  return out;
}

/** true when at least one grave issue is on the job */
function isAffected(issues) {
  return issues.some((id) => SCORED.has(BY_ID.get(id).severity));
}

module.exports = { CHECKS, BY_ID, SCORED, QUESTIONS, QUESTION_OF, issuesOf, isAffected, evidence };
