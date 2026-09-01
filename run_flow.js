"use strict";
const { confirm, closeAsk, c, banner, step } = require("./lib/ask.js");

/**
 * Guided end-to-end workflow.
 * Every step that writes asks first. Answer no and it moves on harmlessly.
 */
async function runFlow(ctx) {
  const { solr, health, normalize, purgeJunk, report, fmt } = ctx;

  banner("peviitor doctor", "guided data quality workflow  -  " + solr.url);

  step(1, 5, "Health check (read only)");
  await health();

  step(2, 5, "Analyse locations (dry run, no writes)");
  await normalize({ apply: false });

  step(3, 5, "Apply the corrections");
  const doApply = await confirm("Write these corrections to Solr?");
  if (doApply) {
    await normalize({ apply: true });
    console.log("  " + c.green("corrections written"));
  } else {
    console.log("  " + c.dim("skipped - nothing written"));
  }

  step(4, 5, "Report");
  const doReport = await confirm("Print the full report and rebuild report.html?");
  if (doReport) await report();
  else console.log("  " + c.dim("skipped"));

  step(5, 5, "Delete junk documents");
  const junkCount = await solr.count("junk:true").catch(() => 0);
  if (!junkCount) {
    console.log("  " + c.dim("no documents flagged junk - nothing to delete"));
  } else {
    console.log("  " + fmt(junkCount) + " documents flagged junk (Romania, Remote, all, ...).");
    await purgeJunk({ preview: true });
    const doPurge = await confirm("Delete these " + fmt(junkCount) + " documents? (cannot be undone)");
    if (doPurge) {
      await purgeJunk({ apply: true });
      console.log("  junk removed");
    } else {
      console.log("  " + c.dim("kept - nothing deleted"));
    }
  }

  console.log("");
  console.log("done.");
  closeAsk();
}
module.exports = { runFlow };
