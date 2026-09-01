# lib/aliases.js — sources and judgement calls

## How this was built

1. Pulled every distinct `location` value behind `international:true` (562 docs,
   210 distinct values) and `junk:true` (2,962 docs, 60 distinct values) from
   Solr via `lib/solr.js` (read-only `scan`). No writes, no `--apply`, no
   `purge-junk` were run.
2. Classified every distinct value by hand into exonym / foreign / junk.
3. Every exonym target was checked against `siruta_index.json` — see the
   verification table below. Two Hungarian exonym candidates that showed up
   in the data (`Varmezo`, `Gyertyamos`) turned out to be ambiguous (each
   name is shared by two or three different Romanian villages in different
   counties) and were left out rather than guessed.
4. Broadened per the task brief: Hungarian/German exonyms for the big
   Transylvanian cities and county seats, country names (Romanian + English)
   and major European cities Romanian recruiters commonly post to, and
   typical job-feed noise words.
5. Self-check (script run ad hoc, not committed — see "Self-check" below)
   confirmed no key appears in more than one of the three lists, and no
   exonym key collides with an official `siruta_index.json` key with a
   different target.

## Results

- `exonyms`: 30 entries
- `foreign`: 318 entries
- `junk`: 54 entries

### Reclassification impact (measured against the live Solr data)

Simulated the same split-by-`[,;/|]` + `key()` lookup the matcher already
uses in `lib/locations.js`, but checking `aliases.exonyms` first:

- **14 of 562** `international:true` docs contain a value that now resolves
  to a real Romanian locality: `Bucharest`, `Marosvasarhely`, `Szekelyudvarhely`,
  `Csikszentsimon` (x2), `Csikszereda` (x2), `Arkos`, `Bukarest`, `Bucarest`,
  `SIGHET`, `Hermannstadt` (x2), `Temeswar`.
- **2 of 2,962** `junk:true` docs resolve the same way: `bukarest` (lowercase,
  which is why it fell into junk rather than international — the existing
  `classify()` heuristic used capitalization as its last-resort international
  signal, `bukarest` starts lowercase so it fell through to junk instead).

These are small numbers because the overwhelming majority of the 562/2,962
docs are genuinely foreign (country/city names, addresses abroad) or
genuinely not a place (street addresses, seniority words, `Remote`, empty
placeholders) — exactly as the sampled data below shows. The value of this
file is precision, not volume: it stops the ~14-16 real Romanian-place docs
from being silently written off as foreign/junk, without touching anything
else.

## Exonym verification (target must exist in siruta_index.json)

All 30 exonym targets were looked up against `siruta_index.json` by the same
`key()` folding the matcher uses. Confirmed present: București, Târgu Mureș,
Miercurea Ciuc, Odorheiu Secuiesc, Sânsimion, Sibiu, Timișoara,
Sighetu Marmației, Arcuș, Cluj-Napoca, Brașov, Oradea, Sighișoara,
Sfântu Gheorghe, Bistrița, Baia Mare, Satu Mare, Alba Iulia, Reșița.

Sources for the exonyms found only in the broadened set (not seen verbatim
in the sampled data), i.e. the standard German/Hungarian names for the
larger Transylvanian cities, are well-documented historical exonyms
(Klausenburg/Kolozsvár = Cluj-Napoca, Kronstadt/Brassó = Brașov,
Nagyszeben = Sibiu, Grosswardein/Nagyvárad = Oradea, Schässburg/Segesvár =
Sighișoara, Sepsiszentgyörgy = Sfântu Gheorghe, Bistritz/Beszterce =
Bistrița, Nagybánya = Baia Mare, Szatmárnémeti = Satu Mare,
Gyulafehérvár/Karlsburg = Alba Iulia, Resicabánya = Reșița). These are
low-risk because the Romanian target is unambiguous and undisputed.

For the three exonyms found in the pulled data that were less familiar,
these were checked individually:

- `Csikszentsimon` → confirmed as the Hungarian name of **Sânsimion**,
  Harghita county (Wikipedia: "Sânsimion").
- `Csikszereda` → confirmed as the Hungarian name of **Miercurea Ciuc**
  (multiple sources).
- `Szekelyudvarhely` → confirmed as the Hungarian name of
  **Odorheiu Secuiesc** (multiple sources).
- `Arkos` (Árkos) → confirmed as the Hungarian name of **Arcuș**, Covasna
  county (Wikidata / Wikipedia: "Arcuș").

## Deliberately left out (judgement calls)

Per "accuracy over volume", these were **not** added to `exonyms` even
though they appear in the data, because the correct target could not be
verified with confidence:

- `Varmezo` (Vármező) — Hungarian name shared by two different Romanian
  villages (Câmpu Cetății, Mureș county, and a village in Buciumi commune,
  Sălaj county) plus unrelated places outside Romania. Ambiguous, left
  unmapped.
- `Gyertyamos` (Gyertyános) — Hungarian name shared by at least two
  different Romanian villages (Carpenii de Sus, Alba county, and Cărpiniș,
  Hunedoara county). Ambiguous, left unmapped.

Also left out, and put in neither list, because they are address fragments
or one-off garbled strings rather than reusable vocabulary:

- `"Aeroport international Henri-Coanda (OTP)"` — clearly means Otopeni
  (Henri Coandă International Airport), but the raw string is a one-off
  compound that would never recur verbatim; not worth hardcoding as a key.
- `"Regiunea Regiunea Bucuresti-Ilfov"` / `"Regiunea Regiunea Sud"` —
  duplicated-word data glitches from the source feed. The Bucuresti-Ilfov
  one clearly means București but the glued key
  (`regiuneregiuneabucurestiilfov`) is too brittle/one-off to add as a
  general-purpose alias.
- `"VN, Romania"`, `"CV, Romania"` — bare two-letter codes. Could be
  Vrancea/Covasna county abbreviations, or could be unrelated
  (Vietnam/curriculum vitae). Too ambiguous out of context.
- `"Piata Montreal, Romania"` — a real square name in București, but not
  generalizable as a standalone key without more context.
- `"contact@flarom.ro, Romania"`, street-address lines
  (`"Str. Apusului 1B"`, `"Soseaua Orhideelor nr15D"`, etc.) — address
  noise, not location vocabulary; these are the matcher's job to strip via
  its existing street-line/postal-code handling in `lib/locations.js`, not
  something this vocabulary file should try to enumerate.
- `"The Barn, Romania"`, `"Vaturro Tailoring, Romania"`,
  `"TAIR Therapy for Autistic Integration and Recovery, Romania"` — read
  like venue/company nicknames rather than places; left unclassified rather
  than guessed.

## Notes on the `foreign` and `junk` lists

- `foreign` includes every genuinely-foreign place actually seen in the
  pulled data (as clean single tokens, e.g. `venezia`, `foshan`, `dresden`,
  `dublin`, `budapest`, `praha`) plus a broadened set of country names
  (Romanian + English forms) and major European cities recruiters commonly
  post to (Netherlands, Germany, Austria, Belgium, Italy, Spain, UK,
  Nordics), per the task brief.
- `junk` includes the noise actually seen (`Remote`, `all`, `Nespecificat`,
  `Strainatate`, `Deplasare`, `Sediul Central`, the internal code
  `RO-BUH-BUCHARESTSEIMAFOF`, the literal counters `2 Locations` /
  `4 Locations` / `13 Locations`) plus a broadened set of standard job-feed
  noise (seniority levels, `hybrid`/`onsite`/`nationwide`, placeholder
  values like `n/a`/`tbd`/`unknown`).

## Self-check

A short script (not committed, per the file-ownership scope of this task —
run ad hoc from the scratchpad) does:

1. Builds a `Set` for each of `exonyms` (keys), `foreign`, `junk` and checks
   pairwise for any key present in more than one list.
2. Loads `siruta_index.json`, builds `key(officialName) -> officialName`,
   and for every `exonyms` entry checks: if the key already exists as an
   official locality, the two names must match exactly (otherwise the
   matcher would silently rewrite a real Romanian locality — flagged as a
   collision); also asserts every exonym target string actually appears as
   an official name in `siruta_index.json`.

Result on this version of `lib/aliases.js`: **no cross-list collisions, no
exonym/siruta collisions** — every exonym key is either absent from
`siruta_index.json` entirely, or (rare) present with the identical target
name.
