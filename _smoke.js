const a = require("./lib/analytics.js");
(async () => {
  for (const fn of ["overview", "locationStats", "categories", "warnings", "salaryStats", "companyStats"]) {
    const t = Date.now();
    try {
      const r = await a[fn]();
      const ms = Date.now() - t;
      let brief;
      if (fn === "overview") brief = JSON.stringify(r);
      else if (fn === "categories") brief = r.method + " | " + r.items.slice(0,6).map(x=>x.category+"="+x.count).join(", ");
      else if (fn === "locationStats") brief = "verified="+r.verified+" intl="+r.international+" junk="+r.junk+" top="+r.topLocalities.slice(0,4).map(x=>x.name+":"+x.count).join(", ");
      else if (fn === "warnings") brief = "weird="+r.weirdTitles.length+" shouting="+(r.shoutingTitles&&r.shoutingTitles.n)+" noSalary="+r.missingSalary.pct+"% noCif="+r.missingCif.pct+"% dup="+r.duplicateTitles.length;
      else if (fn === "salaryStats") brief = "with="+r.withSalary+" pct="+r.pct+" avg="+r.avg+" median="+r.median+" cur="+JSON.stringify(r.currency);
      else brief = r.slice(0,5).map(x=>x.company+":"+x.count).join(", ");
      console.log(fn.padEnd(14) + String(ms+"ms").padStart(8) + "  " + String(brief).slice(0,150));
    } catch (e) {
      console.log(fn.padEnd(14) + "   FAILED  " + e.message.slice(0,120));
    }
  }
})();
