"use strict";
/**
 * lib/peviitor_open.js
 *
 * Opens peviitor.ro in a real, visible browser, runs the search their own UI
 * would run, then finds the exact job in the result list, highlights it and
 * scrolls to it.
 *
 * This has to happen server-side: Playwright drives a browser it launches
 * itself, so the app cannot do it from the user's tab. The window is left open
 * on purpose - the point is for a person to look at it.
 *
 * Routes were found by driving their own search box (tools/probe_peviitor.js):
 *   #/rezultate?q=<term>&page=1   search results
 *   #/company/<CIF>               one company
 */
const SITE = "https://peviitor.ro/";

/** what the highlight looks like, injected into their page */
const MARK_CSS = `
  .bx-hit {
    outline: 3px solid #f59e0b !important;
    outline-offset: 4px;
    border-radius: 10px;
    background: rgba(245, 158, 11, .12) !important;
    scroll-margin-top: 120px;
    animation: bxPulse 1.4s ease-in-out 3;
  }
  @keyframes bxPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(245,158,11,.55); }
    50%      { box-shadow: 0 0 0 14px rgba(245,158,11,0); }
  }
  .bx-hit.bx-weak {
    outline-color: #3b82f6 !important;
    background: rgba(59, 130, 246, .12) !important;
  }
  .bx-flag.weak { border-color: #3b82f6; }
  .bx-flag {
    position: fixed; z-index: 2147483647; left: 50%; transform: translateX(-50%);
    top: 14px; background: #111827; color: #fff; border: 2px solid #f59e0b;
    border-radius: 999px; padding: 10px 20px;
    font: 600 14px/1.3 system-ui, sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.45);
  }
`;

/**
 * Their search ORs the words, so MORE words means MORE noise, not less.
 * Measured on the live site:
 *
 *   q="comunitate"        →   237 results, contains the job
 *   q="Sofer comunitate"  → 2.485 results, does not
 *
 * So we send the single RAREST word of the title, and we know which one is
 * rarest because we can count it in our own index first.
 */
async function rarestWord(title) {
  const words = [...new Set(
    String(title || "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4)
  )];
  if (!words.length) return String(title || "").trim().split(/\s+/)[0] || "";
  if (words.length === 1) return words[0];

  try {
    const path = require("path");
    const { Solr } = require(path.join(__dirname, "solr.js"));
    const solr = new Solr({ core: "job" });
    let best = null;
    for (const w of words.slice(0, 6)) {
      const n = await solr.count('title:"' + w.replace(/"/g, "") + '"');
      if (best === null || n < best.n) best = { w, n };
    }
    return best ? best.w : words[0];
  } catch {
    // no index reachable: fall back to the longest word, usually the rarest
    return words.sort((a, b) => b.length - a.length)[0];
  }
}

function normalise(s) {
  return String(s == null ? "" : s)
    .replace(/[ăâîșț]/g, (c) => ({ "ă": "a", "â": "a", "î": "i", "ș": "s", "ț": "t" }[c]))
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * A company page renders ~15 positions and loads the rest as you scroll -
 * Deloitte shows 15 of its 114 until you reach the bottom. Nothing can be
 * found in a list that has not rendered yet, so walk it to the end first.
 */
async function scrollToEnd(page, { maxRounds = 25 } = {}) {
  let stable = 0, last = 0;
  for (let i = 0; i < maxRounds; i++) {
    const h = await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      return document.body.scrollHeight;
    });
    await page.waitForTimeout(900);
    if (h === last) { stable++; if (stable >= 2) break; } else { stable = 0; last = h; }
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
}

/**
 * Best-effort: tick the company in their own "Companie" filter.
 *
 * There is no URL parameter for it - the filter is a dropdown with checkboxes -
 * so it has to be clicked. If anything about their markup changes this simply
 * returns false and we fall back to matching the card by text, which already
 * identifies the right row on its own.
 */
async function applyCompanyFilter(page, company) {
  if (!company) return false;
  try {
    const btn = page.locator("button", { hasText: /^Companie$/ }).first();
    if (!(await btn.count())) return false;
    await btn.click({ timeout: 5000 });
    await page.waitForTimeout(1200);

    const want = normalise(company);
    const picked = await page.evaluate((w) => {
      const fold = (s) => String(s || "")
        .replace(/[ăâîșț]/g, (c) => ({ "ă": "a", "â": "a", "î": "i", "ș": "s", "ț": "t" }[c]))
        .replace(/\s+/g, " ").trim().toLowerCase();
      const rows = [...document.querySelectorAll("label,li,[role='option'],div")]
        .filter((n) => n.children.length <= 3 && n.innerText && n.innerText.length < 90);
      for (const r of rows) {
        if (fold(r.innerText) !== w) continue;
        const box = r.querySelector("input[type=checkbox]") || r.closest("label")?.querySelector("input[type=checkbox]");
        (box || r).click();
        return true;
      }
      return false;
    }, want);

    if (picked) {
      await page.waitForTimeout(2000);
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(1200);
    }
    return picked;
  } catch { return false; }
}

/**
 * @param {object} opts
 * @param {string} opts.title   the job title to find
 * @param {string} [opts.cif]   company CIF, to open the company page instead
 * @param {string} [opts.company]
 * @param {boolean} [opts.headless]
 */
async function openAndHighlight({ title, cif, company, headless = false } = {}) {
  // Opening a real browser needs Playwright and ~114MB of Chromium, which a
  // free host does not have. Off unless explicitly enabled, and it says so
  // rather than failing in a confusing way.
  const ENV = require(path.join(__dirname, "env.js")).load();
  const enabled = String(ENV.PLAYWRIGHT_ENABLED || process.env.PLAYWRIGHT_ENABLED || "") === "1";
  if (!enabled) {
    return { ok: false, disabled: true, error: "Deschiderea în browser e disponibilă doar local (PLAYWRIGHT_ENABLED=1)." };
  }
  let chromium;
  try { ({ chromium } = require("playwright")); }
  catch { return { ok: false, disabled: true, error: "playwright nu e instalat aici" }; }

  const term = String(title || company || "").trim();
  if (!term && !cif) return { ok: false, error: "nimic de cautat" };

  const browser = await chromium.launch({ headless, args: ["--start-maximized"] });
  const ctx = await browser.newContext({ viewport: null });
  const page = await ctx.newPage();

  // The company page lists exactly that employer's positions, so when we know
  // the CIF we go straight there and look for the title in a short, certain
  // list - far better than hunting it inside 2.000 loosely matched results.
  const viaCompany = !!cif;
  const q = viaCompany ? null : await rarestWord(term);
  const url = viaCompany
    ? SITE + "#/company/" + encodeURIComponent(cif)
    : SITE + "#/rezultate?q=" + encodeURIComponent(q) + "&page=1";

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    // the SPA renders after its own fetch; wait for the list to have content
    await page.waitForTimeout(1200);
    await page.waitForFunction(() => document.body.innerText.length > 800, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const hunt = () => page.evaluate(
      ({ css, wantTitle, wantCompany, label, onCompanyPage }) => {
        if (!document.getElementById("bx-style")) {
          const style = document.createElement("style");
          style.id = "bx-style";
          style.textContent = css;
          document.head.appendChild(style);
        }

        const fold = (s) => String(s || "")
          .replace(/[ăâîșț]/g, (c) => ({ "ă": "a", "â": "a", "î": "i", "ș": "s", "ț": "t" }[c]))
          .replace(/\s+/g, " ").trim().toLowerCase();

        const title = fold(wantTitle);
        const company = fold(wantCompany);
        if (!title) return { hit: false, reason: "fara termen" };

        // A result card is the smallest block that holds BOTH the title and the
        // company. Matching on the title alone picks the wrong row whenever two
        // employers post the same job name — "Gradinar" appears at DACIA PLANT
        // and at VLASA T IOAN, and only the company tells them apart.
        // On a company page the employer is already fixed, and a position is a
        // small heading (an <h3> of ~27px) - so match the title alone and do
        // not demand a tall card that also repeats the company name.
        const sel = onCompanyPage
          ? "h1,h2,h3,h4,li,a,p,div"
          : "div,li,article,section";
        const blocks = [...document.querySelectorAll(sel)];
        const cands = [];
        for (const n of blocks) {
          const t = fold(n.innerText);
          if (!t || t.length > 900) continue;
          if (!t.includes(title)) continue;
          const rect = n.getBoundingClientRect();
          if (!onCompanyPage && rect.height < 60) continue;
          if (onCompanyPage && rect.height < 12) continue;
          cands.push({
            n, t, size: n.innerText.length,
            hasCompany: onCompanyPage ? true : (company ? t.includes(company) : false),
          });
        }
        if (!cands.length) return { hit: false, reason: "nu apare in lista" };

        // prefer a card that also carries the company, then the tightest one
        cands.sort((a, b) => (b.hasCompany - a.hasCompany) || (a.size - b.size));
        const best = cands[0];
        const exact = best.hasCompany || !company;
        const alsoTitle = cands.filter((c) => !c.hasCompany).length;

        best.n.classList.add("bx-hit");
        if (!exact) best.n.classList.add("bx-weak");
        best.n.scrollIntoView({ behavior: "smooth", block: "center" });

        const old = document.querySelector(".bx-flag");
        if (old) old.remove();
        const flag = document.createElement("div");
        flag.className = "bx-flag" + (exact ? "" : " weak");
        flag.textContent = (exact ? "BAROMETRU · " : "BAROMETRU · titlu potrivit, companie nesigură · ") + label;
        document.body.appendChild(flag);

        return {
          hit: true,
          exact,
          candidates: cands.length,
          alsoTitle,
          text: best.n.innerText.replace(/\s+/g, " ").slice(0, 170),
        };
      },
      { css: MARK_CSS, wantTitle: term, wantCompany: company || "", label: (title || company || "").slice(0, 70), onCompanyPage: viaCompany && !fellBackRef.v }
    );

    // narrowing by their own company filter makes the list short and exact;
    // if it does not work we still find the row by text below
    // the company page lazy-loads its positions; render them all first
    if (viaCompany) await scrollToEnd(page);
    const filtered = viaCompany ? false : await applyCompanyFilter(page, company);

    const fellBackRef = { v: false };
    let found = await hunt();

    // if the company page did not carry the job, fall back to a site search
    let fellBack = false;
    if (viaCompany && !found.hit && term) {
      fellBack = true; fellBackRef.v = true;
      const q2 = await rarestWord(term);
      await page.goto(SITE + "#/rezultate?q=" + encodeURIComponent(q2) + "&page=1",
        { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(2500);
      await applyCompanyFilter(page, company);
      found = await hunt();
    }

    // Walk the result pages until the job turns up or the list genuinely ends.
    // Stopping at page 4 was arbitrary: a loose match can run to dozens of
    // pages and the job we want may be on any of them.
    const searchQ = fellBack ? await rarestWord(term) : q;
    let lastPage = 1;
    if (!found.hit && searchQ) {
      for (let pg = 2; pg <= 60; pg++) {
        await page.goto(SITE + "#/rezultate?q=" + encodeURIComponent(searchQ) + "&page=" + pg,
          { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(1700);

        const empty = await page.evaluate(() =>
          !/de rezultate/i.test(document.body.innerText) || document.body.innerText.length < 700);
        if (empty) break;                       // ran off the end of the list

        found = await hunt();
        lastPage = pg;
        if (found.hit) { found.page = pg; break; }
      }
    }

    // leave the window open for the person who asked for it
    return {
      ok: true, url, query: q, headless,
      found: !!found.hit,
      exact: !!found.exact,               // title AND company matched
      candidates: found.candidates || 0,
      companyFilter: filtered,
      via: viaCompany && !fellBack ? "pagina companiei" : "cautare pe site",
      page: found.page || 1,
      pagesSearched: lastPage,
      detail: found.text || found.reason || "",
      browserLeftOpen: !headless,
    };
  } catch (e) {
    await browser.close().catch(() => {});
    return { ok: false, error: String(e.message).slice(0, 200), url };
  } finally {
    if (headless) await browser.close().catch(() => {});
  }
}

module.exports = { openAndHighlight, normalise, SITE };
