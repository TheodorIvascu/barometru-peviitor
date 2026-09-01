"use strict";
/**
 * Vocabulary for the location matcher: Romanian places that show up in job
 * postings under a foreign-language or unofficial name (exonyms), genuinely
 * foreign places (foreign), and values that are not a place at all (junk).
 *
 * Key format (see `key` below): lowercase, Romanian diacritics folded to
 * ascii (ă->a, â->a, î->i, ș->s, ț->t), then strip everything that is not
 * a-z0-9. Apply the same folding to any raw value before looking it up here.
 *
 * Every exonym target below was checked against siruta_index.json - see
 * ALIASES.md for how, and for the sources behind each judgement call.
 */

const DIA = {
  "ă": "a", "â": "a", "î": "i", "ș": "s", "ț": "t",
  "ş": "s", "ţ": "t",
  "Ă": "a", "Â": "a", "Î": "i", "Ș": "s", "Ț": "t", "Ş": "s", "Ţ": "t",
};
const strip = (s) => String(s).replace(/[ăâîșțşţĂÂÎȘȚŞŢ]/g, (c) => DIA[c] || c);
const key = (s) => strip(s).toLowerCase().replace(/[^a-z0-9]/g, "");

// ---------------------------------------------------------------------------
// EXONYMS - Romanian places written in another language or an unofficial /
// historic form. Value is the official siruta_index.json name.
// ---------------------------------------------------------------------------
const exonyms = {
  // --- found verbatim in the international/junk data (Solr `location`) ---
  "bucharest": "București",          // English
  "bukarest": "București",           // German
  "bucarest": "București",           // French / Italian / Spanish
  "marosvasarhely": "Târgu Mureș",   // Hungarian
  "csikszereda": "Miercurea Ciuc",   // Hungarian
  "szekelyudvarhely": "Odorheiu Secuiesc", // Hungarian
  "csikszentsimon": "Sânsimion",     // Hungarian (confirmed: en.wikipedia.org/wiki/Sânsimion)
  "hermannstadt": "Sibiu",           // German
  "temeswar": "Timișoara",           // German (older spelling)
  "sighet": "Sighetu Marmației",     // common short Romanian form
  "arkos": "Arcuș",                  // Hungarian (Árkos), confirmed via Wikidata/Wikipedia

  // --- broadened: well-known Hungarian/German exonyms for big Transylvanian
  //     cities and county seats, per task instructions (not seen verbatim in
  //     the sampled data, but highly likely to appear in future postings) ---
  "klausenburg": "Cluj-Napoca",      // German
  "kolozsvar": "Cluj-Napoca",        // Hungarian
  "kronstadt": "Brașov",             // German
  "brasso": "Brașov",                // Hungarian
  "temeschburg": "Timișoara",        // German
  "temesvar": "Timișoara",           // Hungarian
  "nagyszeben": "Sibiu",             // Hungarian
  "grosswardein": "Oradea",          // German
  "nagyvarad": "Oradea",             // Hungarian
  "schassburg": "Sighișoara",        // German
  "segesvar": "Sighișoara",          // Hungarian
  "sepsiszentgyorgy": "Sfântu Gheorghe", // Hungarian
  "bistritz": "Bistrița",            // German
  "beszterce": "Bistrița",           // Hungarian
  "nagybanya": "Baia Mare",          // Hungarian
  "szatmarnemeti": "Satu Mare",      // Hungarian
  "gyulafehervar": "Alba Iulia",     // Hungarian
  "karlsburg": "Alba Iulia",         // German
  "resicabanya": "Reșița",           // Hungarian
};

// ---------------------------------------------------------------------------
// FOREIGN - real places outside Romania that show up in postings (job
// board noise, remote-from-abroad listings, etc). Includes country names
// (Romanian + English) and the specific foreign cities seen in the data,
// plus a broadened set of common European job-market cities/countries.
// ---------------------------------------------------------------------------
const foreign = [
  // countries - Romanian and English/local forms
  "olanda", "netherlands", "nederland", "tariledejos",
  "germania", "germany", "deutschland",
  "austria", "osterreich",
  "belgia", "belgium",
  "franta", "france",
  "italia", "italy",
  "spania", "spain",
  "portugalia", "portugal",
  "anglia", "uk", "unitedkingdom", "mareabritanie", "regatulunit", "england", "scotia", "scotland", "wales",
  "irlanda", "ireland",
  "norvegia", "norway",
  "suedia", "sweden",
  "danemarca", "denmark",
  "finlanda", "finland",
  "elvetia", "switzerland",
  "cehia", "czechia", "czechrepublic",
  "slovacia", "slovakia",
  "ungaria", "hungary",
  "polonia", "poland",
  "bulgaria",
  "grecia", "greece",
  "malta",
  "cipru", "cyprus",
  "luxemburg", "luxembourg", "luxembourgcity",
  "republicofmoldova", "ucraina", "ukraine",
  "usa", "sua", "statauniteamericii", "canada",
  "mexic", "mexico", "cdmx", "mexicocity",
  "china", "israel",
  "emiratelearabeunite", "emirate", "qatar", "dubai", "alkuwait", "kuwait", "arabiasaudita", "saudiarabia",
  "turcia", "turkey",
  "serbia", "croatia", "slovenia", "estonia", "letonia", "latvia", "lituania", "lithuania", "republicoflithuania",
  "islanda", "iceland",
  "japonia", "japan",
  "coreea", "southkorea",
  "australia",
  "tanzania", "egipt", "egypt", "maroc", "morocco",
  "india", "vietnam", "thailanda", "thailand", "singapore",
  "brazilia", "brazil",

  // cities seen verbatim in the sampled international values
  "amsterdam", "rotterdam", "venlo", "eindhoven", "utrecht", "denhaag", "hague", "thehague",
  "breda", "tilburg", "veenendaal", "zaltbommel", "losser", "goes", "arnhem", "rozenburg",
  "venezia", "venice", "padova", "padua", "milano", "milan", "roma", "rome", "torino", "turin",
  "napoli", "naples", "firenze", "florence", "bologna", "trieste", "merano", "vittorioveneto",
  "bratislava", "praha", "prague", "brno", "nitra", "dacice",
  "dresden", "munchen", "munich", "nurnberg", "nurenberg", "berlin", "hamburg", "frankfurt",
  "stuttgart", "koln", "cologne", "freiburg", "weingarten", "regensburg", "magdeburg",
  "dortmund", "erkelenz", "kuppenheim", "raunheim", "hofheimamtaunus", "altenberge",
  "gunzburg", "heilbronn", "rechlin", "stadthagen", "dingolfing", "hollenbach", "koblenz",
  "dobeln", "reutlingen", "tubingen", "balingen", "wuppertal", "solingen", "dusseldorf",
  "lubeck", "pinneberg", "flensburg", "leipzig", "hannover", "bielefeld", "salzwedel",
  "haldensleben", "estulgermaniei",
  "bruxelles", "brussels", "liege", "herstal", "antwerpen", "gent", "lommel",
  "colombes", "colombier", "blois", "frejus", "cannes",
  "wien", "vienna", "viena", "salzburg", "graz", "linz", "innsbruck", "axams", "badgastein", "lungotz", "wals",
  "zurich", "geneva", "bern", "basel", "glattbrugg",
  "paris", "lyon", "marseille",
  "madrid", "barcelona", "valencia", "sevilla", "benahavis",
  "lisabona", "lisbon", "porto", "memmartins",
  "dublin", "cork", "galway", "limerick", "belfast", "ashbourne", "meath", "longford",
  "tipperary", "roxborough", "cavan",
  "glasgow", "edinburgh", "cardiff", "leeds", "liverpool", "bristol",
  "london", "londra", "manchester", "birmingham", "slough", "hemelhempstead", "hertfordshire",
  "oslo", "trondheim", "sande", "bergen", "boden", "gavle",
  "stockholm", "goteborg", "gothenburg", "malmo",
  "copenhaga", "copenhagen", "fredericia", "rudkobing",
  "helsinki", "espoo", "hyvinkaa",
  "budapesta", "budapest", "abony", "nagykoros",
  "varsovia", "warsaw", "gdansk", "krakow", "bydgoszcz",
  "sofia", "atena", "athens", "istanbul", "ankara",
  "foshan", "shanghai", "beijing", "shenzhen", "hangzhou", "shaoxing",
  "toronto", "montreal", "newyork", "chicago", "boston", "seattle", "texas",
  "dallas", "dallastx", "jacksonville", "jacksonvillefl", "grandrapids", "grandrapidsmi", "oakland",
  "paje", "zanzibar", "doha", "nicosia", "plovdiv", "varna", "skalapotamias",
  "vilhena", "bengaluru", "chennai",
];

// ---------------------------------------------------------------------------
// JUNK - not a place at all: empty/placeholder values, seniority levels,
// generic job-feed noise, internal codes.
// ---------------------------------------------------------------------------
const junk = [
  // seen verbatim in the sampled international/junk data
  "romania", "remote", "hybrid", "onsite", "strainatate", "all", "nespecificat",
  "medior", "deplasare", "sediulcentral", "europe", "toate",
  "activitatelanivelnational", "vasdecroaziera", "regiuneregiunesud",
  "robuhbucharestseimafof",
  "2locations", "4locations", "13locations",

  // broadened: typical non-place noise in job feeds
  "multiplelocations", "nationwide", "national", "countrywide", "various",
  "na", "null", "none", "tbd", "nu", "necunoscut", "unspecified", "unknown",
  "senior", "junior", "entry", "mid", "midlevel", "principal", "lead", "staff",
  "intern", "internship", "stagiu", "stagiar", "trainee", "fresher",
  "office", "hq", "sediu", "punctdelucru", "zona", "area", "test", "n/a",
];

module.exports = { exonyms, foreign, junk, key };
