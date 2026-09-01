#!/usr/bin/env node
"use strict";
/**
 * tools/probe_peviitor.js
 *
 * Drives peviitor.ro in a real browser to find out how its search actually
 * works, instead of guessing from the bundle. Types a term into their own
 * search box, submits, and reports the URL that produces and whether results
 * appeared. Then tests candidate deep-links against the same expectation.
 *
 *   node tools/probe_peviitor.js "sofer"
 */
const { chromium } = require("playwright");

const TERM = process.argv[2] || "sofer";
const SITE = "https://peviitor.ro/";

const log = (...a) => console.log(...a);

async function countResults(page) {
  // whatever the markup, a results page shows many links out to job pages
  return page.evaluate(() => {
    const anchors = [...document.querySelectorAll("a[href^='http']")]
      .filter((a) => !/peviitor\.ro/i.test(a.getAttribute("href") || ""));
    const cards = document.querySelectorAll("[class*='card'], [class*='job'], article, li");
    return { outboundLinks: anchors.length, blocks: cards.length, chars: document.body.innerText.length };
  });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  log("=== 1. deschid " + SITE + " ===");
  await page.goto(SITE, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  log("titlu:", await page.title());
  log("url  :", page.url());

  const baseline = await countResults(page);
  log("baza :", JSON.stringify(baseline));

  // --- find their own search input -------------------------------------
  log("\n=== 2. caut caseta de cautare ===");
  const inputs = await page.evaluate(() =>
    [...document.querySelectorAll("input")].map((i, n) => ({
      n, type: i.type, name: i.name, id: i.id,
      placeholder: i.placeholder, cls: i.className.slice(0, 60),
    }))
  );
  log(JSON.stringify(inputs, null, 1));

  if (!inputs.length) { log("nicio casetă găsită"); await browser.close(); return; }

  // pick the most search-looking one
  const idx = inputs.findIndex((i) =>
    /search|caut|cuvant|job/i.test((i.placeholder || "") + (i.name || "") + (i.id || "") + (i.cls || ""))
  );
  const target = idx >= 0 ? idx : 0;
  log("folosesc caseta #" + target);

  const handle = (await page.$$("input"))[target];
  await handle.click();
  await handle.fill(TERM);
  await page.waitForTimeout(600);
  await handle.press("Enter");
  await page.waitForTimeout(4000);

  log("\n=== 3. dupa cautare ===");
  log("url  :", page.url());
  const after = await countResults(page);
  log("acum :", JSON.stringify(after));

  const body = await page.evaluate(() => document.body.innerText.slice(0, 400));
  log("text :", JSON.stringify(body.slice(0, 260)));

  // --- try candidate deep links ----------------------------------------
  log("\n=== 4. testez adrese directe ===");
  const candidates = [
    SITE + "?q=" + encodeURIComponent(TERM),
    SITE + "?search=" + encodeURIComponent(TERM),
    SITE + "#/?q=" + encodeURIComponent(TERM),
    SITE + "rezultate?q=" + encodeURIComponent(TERM),
    page.url(),
  ];
  for (const url of [...new Set(candidates)]) {
    const p2 = await browser.newPage();
    let status = "?";
    try {
      const resp = await p2.goto(url, { waitUntil: "networkidle", timeout: 45000 });
      status = resp ? resp.status() : "n/a";
      await p2.waitForTimeout(3000);
      const c = await countResults(p2);
      const txt = await p2.evaluate(() => document.body.innerText.slice(0, 120).replace(/\s+/g, " "));
      const hit = c.outboundLinks > baseline.outboundLinks + 2;
      log((hit ? "  DA  " : "  nu  ") + String(status).padEnd(4) + " " + url);
      log("        linkuri=" + c.outboundLinks + " (baza " + baseline.outboundLinks + ")  «" + txt.slice(0, 80) + "»");
    } catch (e) {
      log("  EROARE " + url + " — " + String(e.message).slice(0, 70));
    }
    await p2.close();
  }

  await browser.close();
})();
