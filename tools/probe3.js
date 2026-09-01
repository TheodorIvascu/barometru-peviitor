const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const q = "Sofer comunitate 107 E/ zi";
  await p.goto("https://peviitor.ro/#/rezultate?q=" + encodeURIComponent(q) + "&page=1", { waitUntil: "domcontentloaded", timeout: 60000 });
  await p.waitForTimeout(5000);
  const info = await p.evaluate(() => {
    const txt = document.body.innerText;
    const m = txt.match(/([\d\s.]+)\s*de rezultate/);
    return { total: m ? m[1].trim() : "?", primele: txt.split("\n").filter(l=>l.trim()).slice(4, 16) };
  });
  console.log("rezultate:", info.total);
  console.log(info.primele.join("\n"));
  await b.close();
})();
