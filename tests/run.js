#!/usr/bin/env node
"use strict";
/**
 * Offline tests. No Solr, no network.
 *
 *   node tests/run.js
 *
 * 1. location classifier against tests/cases.json
 * 2. CIF checksum
 * 3. every check fires on a document built to trip it, and stays quiet on a clean one
 */
const fs = require("fs");
const path = require("path");
const { loadIndex, classify, countyFor } = require("../src/locations.js");
const { cifChecksumOk, cifKey } = require("../src/cif.js");
const { enrichJob } = require("../src/enrich.js");
const { CHECKS, issuesOf } = require("../src/checks.js");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log("  FAIL  " + msg); } };

// ---- 1. locations ---------------------------------------------------------------
const index = loadIndex(path.join(ROOT, "data"));
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "cases.json"), "utf8"));
console.log(`locations  (${cases.length} cases, index ${index.ms}ms, ${index.localities} localities)`);
for (const c of cases) {
  const r = classify(c.input, index);
  const got = r.kind + (r.value ? ":" + r.value : "");
  if (c.expectKind !== undefined) ok(r.kind === c.expectKind, `${JSON.stringify(c.input)} expected kind ${c.expectKind}, got ${got}`);
  if (c.expectValue !== undefined) ok(r.value === c.expectValue, `${JSON.stringify(c.input)} expected ${c.expectValue}, got ${got}`);
  if (c.notValue !== undefined) ok(r.value !== c.notValue, `${JSON.stringify(c.input)} must not be ${c.notValue}`);
  if (c.notKind !== undefined) ok(r.kind !== c.notKind, `${JSON.stringify(c.input)} must not be kind ${c.notKind}`);
}
// counties
const county = (s) => countyFor(s, classify(s, index), index);
ok(county("Cluj-Napoca, Romania") === "Cluj", "Cluj-Napoca -> Cluj, got " + county("Cluj-Napoca, Romania"));
ok(county("Sector 3, Romania") === "București", "Sector 3 -> București, got " + county("Sector 3, Romania"));
ok(county("Timisoara") === "Timiș", "Timisoara -> Timiș, got " + county("Timisoara"));
ok(county("Iasi, Iasi") === "Iași", "Iasi -> Iași, got " + county("Iasi, Iasi"));
ok(classify("Romania", index).how === "placeholder", "bare 'Romania' is a placeholder");
ok(classify("Remote, Romania", index).how === "placeholder", "'Remote, Romania' is a placeholder");

// ---- 2. CIF ----------------------------------------------------------------------------
console.log("cif");
ok(cifChecksumOk("24973770"), "24973770 (GSE ROMANIA) passes checksum");
ok(cifChecksumOk("RO24973770"), "RO prefix folded before checksum");
ok(!cifChecksumOk("24973771"), "24973771 fails checksum");
ok(!cifChecksumOk("abc"), "letters fail");
ok(cifKey("RO 08119423") === "8119423", "cifKey strips RO, spaces, leading zeros");

// ---- 3. checks -----------------------------------------------------------------------------
console.log(`checks     (${CHECKS.length} checks)`);
const now = Date.parse("2026-09-05T12:00:00Z");
const companies = new Map([["24973770", { key: "24973770", name: "GSE ROMANIA SRL", status: "activ" }],
  ["31468843", { key: "31468843", name: "FLOREA I. MIHAELA PERSOANĂ FIZICĂ AUTORIZATĂ", status: "inactiv" }],
  ["12345670", { key: "12345670", name: "FIRMA IN FUNCTIUNE SRL", status: "funcțiune" }]]);
const ctx = { index, companies, now };
const clean = { url: "https://example.ro/job/1", title: "Șofer categoria B", company: "GSE ROMANIA SRL", cif: "24973770",
  location: ["Cluj-Napoca, Romania"], tags: ["sofer", "transport"], workmode: "on-site", date: "2026-09-01T08:00:00Z", status: "scraped" };
const doc = (over) => enrichJob({ ...clean, ...over }, ctx);
const fires = (id, e, checkCtx) => issuesOf(e, checkCtx || { now, dups: new Map() }).includes(id);

const cleanIssues = issuesOf(doc({}), { now, dups: new Map() });
ok(cleanIssues.length === 1 && cleanIssues[0] === "missing_salary", "clean doc trips nothing but missing_salary, got " + JSON.stringify(cleanIssues));

const trips = {
  missing_title: { title: "" }, missing_company: { company: "" }, missing_cif: { cif: "" }, missing_location: { location: [] },
  missing_date: { date: "" }, missing_workmode: { workmode: "" }, missing_tags: { tags: [] }, missing_salary: {},
  url_invalid: { url: "ftp://x" }, title_too_long: { title: "a".repeat(201) }, title_html: { title: "M&amp;E Site Manager" },
  title_untrimmed: { title: " Șofer " }, company_not_uppercase: { company: "Gse Romania Srl" }, company_html: { company: "IONUT&amp;MADA S.R.L." },
  tags_diacritics: { tags: ["șofer"] }, tags_not_lowercase: { tags: ["Sofer"] }, tags_too_many: { tags: Array.from({ length: 21 }, (_, i) => "t" + i) },
  workmode_invalid: { workmode: "office" }, status_invalid: { status: "activ" }, date_invalid: { date: "2027-01-01T00:00:00Z" },
  vdate_while_scraped: { vdate: "2026-09-01T00:00:00Z" }, expiration_too_far: { vdate: "2026-08-01T00:00:00Z", expirationdate: "2026-09-15T00:00:00Z", status: "verified" },
  salary_bad_format: { salary: "3000 lei" }, cif_not_8_digits: { cif: "1234567" }, cif_ro_prefix: { cif: "RO24973770" },
  cif_bad_checksum: { cif: "24973771" }, cif_orphan: { cif: "12345678" }, company_mismatch: { company: "ALTA FIRMA SRL" },
  company_not_active: { cif: "31468843", company: "FLOREA I. MIHAELA PERSOANĂ FIZICĂ AUTORIZATĂ" },
  company_status_invalid: { cif: "12345670", company: "FIRMA IN FUNCTIUNE SRL" },
  loc_gibberish: { location: ["RO-BUH-BUCHARESTSEIMAFOF, Romania"] }, loc_placeholder: { location: ["Romania"] }, loc_foreign: { location: ["Amsterdam, Romania"] },
  title_adult: { title: "Model videochat" },
  title_other_alphabet: { title: "Фотограф квартир" },
  title_mixed_alphabets: { title: "Asistent Rаdiologie si Imagisticа Mеdicala" }, title_fancy_letters: { title: "𝐎𝐩𝐞𝐫𝐚𝐭𝐨𝐫" }, text_mojibake: { title: "Juniorâ€“Mid Hardware Support" }, contact_in_ad: { title: "Sofer, tel 0722 123 456" }, title_too_short: { title: "--" },
  title_allcaps: { title: "SOFER CATEGORIA B" }, stale_scraped: { date: "2026-07-01T00:00:00Z" }, very_old: { date: "2026-05-01T00:00:00Z" },
};
for (const c of CHECKS) {
  if (c.id === "repeated_listing" || c.id === "url_dead" || c.id === "url_error" || c.id === "loc_county_unknown") continue;
  ok(trips[c.id] !== undefined, `no tripping doc written for ${c.id}`);
  if (trips[c.id] !== undefined) ok(fires(c.id, doc(trips[c.id])), `${c.id} should fire on ${JSON.stringify(trips[c.id])}`);
}
const copy = doc({}); copy.dupIndex = 1;
ok(fires("repeated_listing", copy), "a repeat is measured on the second copy");
ok(!fires("repeated_listing", doc({})), "the first copy is not a repeat");
const dead = doc({}); dead.link = "dead"; dead.linkCode = 404;
ok(fires("url_dead", dead), "url_dead fires on a probed 404");
ok(!fires("url_dead", doc({})), "url_dead stays quiet when not probed");
const bad = doc({}); bad.link = "error"; bad.linkCode = 500;
ok(fires("url_error", bad), "url_error fires on a 500");
ok(!fires("url_dead", bad), "a 500 is not reported as gone for good");
ok(!fires("url_error", dead), "a 404 is not reported as a server error");
const slow = doc({}); slow.link = "unreachable";
ok(!fires("url_error", slow) && !fires("url_dead", slow), "no answer at all is neither");
ok(!fires("title_html", doc({ title: "Șofer & curier" })), "a bare & is not HTML");
ok(!fires("company_not_uppercase", doc({ company: "S.C. ȚARA S.R.L." })), "uppercase with diacritics passes");

// a company the catalogue calls "funcțiune" IS operating: it must not be reported as gone
ok(!fires("company_not_active", doc({ cif: "12345670", company: "FIRMA IN FUNCTIUNE SRL" })), "status funcțiune is not a dead company");
ok(!fires("company_not_active", doc({ cif: "12345678" })), "a company missing from the catalogue is orphan, not inactive");
ok(fires("cif_orphan", doc({ cif: "12345678" })), "a company missing from the catalogue is an orphan");

// adult: the word list alone produced false positives on real titles
const adult = (t) => fires("title_adult", doc({ title: t }));
ok(adult("Model Videochat"), "videochat is adult");
ok(adult("Chatter OnlyFans"), "onlyfans is adult");
ok(adult("Technical & Creative Streaming (Adult Industry)"), "adult industry is adult");
ok(adult("Animatoare Hostess Passion Night Club"), "two weak words plus a club is adult");
ok(adult("Hostess si Dansatoare JOB IN ITALIA"), "hostess plus dansatoare is adult");
ok(!adult("Webchat non-adult - program flexibil"), "a title that says non-adult is not adult");
ok(!adult("Angajam animatoare zile nastere copii"), "a childrens entertainer is not adult");
ok(!adult("Formator invatamant adulti"), "adult education is not adult content");
ok(!adult("Maseur recuperare medicala"), "medical massage is not adult");

// a title is unusable when it has no letters, in any alphabet
ok(!fires("title_too_short", doc({ title: "𝐎𝐩𝐞𝐫𝐚𝐭𝐨𝐫" })), "unicode bold letters are letters");
ok(!fires("title_too_short", doc({ title: "Фотограф квартир" })), "cyrillic letters are letters");
ok(fires("title_too_short", doc({ title: "12345" })), "digits only is unusable");
ok(!fires("title_fancy_letters", doc({ title: "Sofer categoria B" })), "plain letters are not decorative");
ok(!fires("title_other_alphabet", doc({ title: "Operator customer service-Bulgara/Български" })), "an honest bilingual title is not flagged");
ok(!fires("title_mixed_alphabets", doc({ title: "Operator customer service-Bulgara/Български" })), "a whole word in another alphabet is not a homoglyph");
ok(!fires("title_mixed_alphabets", doc({ title: "Șofer categoria B" })), "romanian diacritics are latin");

// phone / email: the old rule matched any nine digits, so salary ranges were "personal data"
ok(fires("contact_in_ad", doc({ title: "asistent comercial 0762489789" })), "a mobile number in the title");
ok(fires("contact_in_ad", doc({ title: "Dealer Casino 0751 623 901" })), "a mobile number written with spaces");
ok(fires("contact_in_ad", doc({ location: ["tel. 0742946348, Strada Mihai"] })), "a phone number in the location");
ok(fires("contact_in_ad", doc({ location: ["contact@flarom.ro, Romania"] })), "an email in the location");
ok(fires("contact_in_ad", doc({ tags: ["sunati", "0723697746"] })), "a phone number in the tags");
ok(!fires("contact_in_ad", doc({ title: "Electrician: intre 2650-2800 EUR net/168 ore" })), "a salary range is not a phone number");
ok(!fires("contact_in_ad", doc({ title: "Mecanic auto (Germania) 2400-2700 EUR net" })), "a second salary range");
ok(!fires("contact_in_ad", doc({ tags: ["sudor 135136138 reparatii"] })), "a product code is not a phone number");
ok(!fires("contact_in_ad", doc({ title: "Senior Accounting Specialist@Flip.ro" })), "a board title convention is not an email");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
