const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto("https://peviitor.ro/#/rezultate?q=" + encodeURIComponent("comunitate Sofer") + "&page=1",
    { waitUntil: "domcontentloaded", timeout: 60000 });
  await p.waitForTimeout(6000);
  const r = await p.evaluate(() => {
    const txt = document.body.innerText;
    const m = txt.match(/([\d\s.]+)\s*de rezultate/);
    // job titles look like links or headings inside cards
    const cards = [...document.querySelectorAll("a,h2,h3")].map(n => n.innerText.trim()).filter(t => t.length > 8 && t.length < 110);
    return { total: m ? m[1].trim() : "?", cards: cards.slice(0, 10), htmlSample: document.body.innerHTML.slice(0, 300) };
  });
  console.log("total:", r.total);
  console.log("titluri gasite:", JSON.stringify(r.cards, null, 1));
  await b.close();
})();
