const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  const urls = [
    "https://peviitor.ro/#/company/14893797",
    "https://peviitor.ro/#/company/22915705",
    "https://peviitor.ro/#/rezultate?q=" + encodeURIComponent("DELOITTE TAX SRL") + "&page=1",
  ];
  for (const u of urls) {
    const p = await b.newPage();
    try {
      await p.goto(u, { waitUntil: "networkidle", timeout: 60000 });
      await p.waitForTimeout(3500);
      const t = await p.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 190));
      console.log("\n" + u);
      console.log("   " + t);
    } catch (e) { console.log("\n" + u + "\n   EROARE " + String(e.message).slice(0, 70)); }
    await p.close();
  }
  await b.close();
})();
