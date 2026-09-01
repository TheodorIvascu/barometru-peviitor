const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 950 } });
  await p.goto("https://peviitor.ro/#/rezultate?q=Gradinar&page=1", { waitUntil: "domcontentloaded", timeout: 60000 });
  await p.waitForTimeout(5000);

  // 1. does a URL param work?
  for (const u of [
    "https://peviitor.ro/#/rezultate?q=Gradinar&company=VLASA%20T%20IOAN%20PF&page=1",
    "https://peviitor.ro/#/rezultate?q=Gradinar&companie=VLASA%20T%20IOAN%20PF&page=1",
  ]) {
    const p2 = await b.newPage();
    await p2.goto(u, { waitUntil: "domcontentloaded", timeout: 45000 });
    await p2.waitForTimeout(4000);
    const t = await p2.evaluate(() => { const m = document.body.innerText.match(/([\d\s.]+)\s*de rezultate/); return m ? m[1].trim() : "?"; });
    console.log("param:", u.split("&")[1], "-> rezultate:", t);
    await p2.close();
  }

  // 2. what does the Companie control look like?
  console.log("\n=== controale filtru ===");
  const ctrls = await p.evaluate(() =>
    [...document.querySelectorAll("button,div[role='button'],select")]
      .map(n => ({ tag: n.tagName, txt: (n.innerText||"").trim().slice(0,26), cls: (n.className||"").toString().slice(0,50) }))
      .filter(x => /companie|localitate|mod de lucru/i.test(x.txt))
  );
  console.log(JSON.stringify(ctrls, null, 1));

  // 3. click it and see what appears
  const btn = p.locator("text=Companie").first();
  await btn.click().catch(()=>{});
  await p.waitForTimeout(2500);
  const after = await p.evaluate(() => {
    const inputs = [...document.querySelectorAll("input")].map(i => ({ ph: i.placeholder, cls: (i.className||"").slice(0,40) }));
    const opts = [...document.querySelectorAll("li,label,[role='option']")].map(n => (n.innerText||"").trim()).filter(t=>t&&t.length<50).slice(0,12);
    return { inputs, opts };
  });
  console.log("\ndupa click pe Companie:");
  console.log(JSON.stringify(after, null, 1));
  await b.close();
})();
