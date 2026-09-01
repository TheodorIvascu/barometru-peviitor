const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 950 } });
  await p.goto("https://peviitor.ro/#/company/22915705", { waitUntil: "domcontentloaded", timeout: 60000 });
  await p.waitForTimeout(5000);
  const before = await p.evaluate(() => ({
    titles: [...document.querySelectorAll("h3")].map(n=>n.innerText.trim()).length,
    hasTarget: /AR Disputes Specialist/i.test(document.body.innerText),
    text: document.body.innerText.replace(/\s+/g," ").slice(0,130),
    height: document.body.scrollHeight,
  }));
  console.log("initial:", JSON.stringify(before));
  // scroll to the bottom repeatedly in case it lazy-loads
  for (let i=0;i<8;i++){ await p.evaluate(()=>window.scrollTo(0,document.body.scrollHeight)); await p.waitForTimeout(1200); }
  const after = await p.evaluate(() => ({
    titles: [...document.querySelectorAll("h3")].map(n=>n.innerText.trim()).length,
    hasTarget: /AR Disputes Specialist/i.test(document.body.innerText),
    sample: [...document.querySelectorAll("h3")].slice(0,5).map(n=>n.innerText.trim()),
    pager: [...document.querySelectorAll("button,a")].map(n=>n.innerText.trim()).filter(t=>/^\d+$|urmator|next|mai mult/i.test(t)).slice(0,8),
  }));
  console.log("dupa scroll:", JSON.stringify(after, null, 1));
  await b.close();
})();
