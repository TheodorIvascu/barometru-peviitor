const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  for (const q of ["comunitate", "Sofer comunitate"]) {
    const p = await b.newPage();
    await p.goto("https://peviitor.ro/#/rezultate?q=" + encodeURIComponent(q) + "&page=1",
      { waitUntil: "domcontentloaded", timeout: 60000 });
    await p.waitForTimeout(5500);
    const r = await p.evaluate(() => {
      const txt = document.body.innerText;
      const m = txt.match(/([\d\s.]+)\s*de rezultate/);
      const hit = /comunitate 107/i.test(txt);
      const titles = [...document.querySelectorAll("a,h2,h3")].map(n=>n.innerText.trim()).filter(t=>t.length>8&&t.length<110).slice(1,6);
      return { total: m?m[1].trim():"?", hit, titles };
    });
    console.log("q=" + JSON.stringify(q), "| total:", r.total, "| contine jobul:", r.hit);
    console.log("   " + r.titles.join("\n   "));
    await p.close();
  }
  await b.close();
})();
