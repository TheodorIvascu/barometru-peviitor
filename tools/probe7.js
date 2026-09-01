const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  for (const cif of ["1410120104977", "22915705"]) {
    const p = await b.newPage();
    await p.goto("https://peviitor.ro/#/company/" + cif, { waitUntil: "domcontentloaded", timeout: 60000 });
    await p.waitForTimeout(5000);
    const r = await p.evaluate(() => {
      const txt = document.body.innerText.replace(/\s+/g, " ");
      // how are the positions rendered?
      const items = [...document.querySelectorAll("li,a,h3,h4,p,div")]
        .filter(n => n.children.length === 0 && n.innerText && n.innerText.trim().length > 3 && n.innerText.trim().length < 90)
        .map(n => ({ tag: n.tagName, h: Math.round(n.getBoundingClientRect().height), t: n.innerText.trim() }));
      return { head: txt.slice(0, 150), items: items.slice(0, 14) };
    });
    console.log("\n=== CIF " + cif + " ===");
    console.log(r.head);
    console.log(JSON.stringify(r.items, null, 1).slice(0, 900));
    await p.close();
  }
  await b.close();
})();
