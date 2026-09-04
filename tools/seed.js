"use strict";
/**
 * tools/seed.js — promote the current analysis to the snapshot committed in git.
 *
 * Run it after a local analysis you are happy with, then commit seed/. The file
 * ships inside the image, so a freshly started container has real numbers on
 * screen from the first second instead of a minute of dashes.
 *
 *   node tools/seed.js
 */
const snap = require("../lib/snapshot.js");
const live = snap.save();
if (!live.ok) { console.error("nu pot construi instantaneul: " + live.error); process.exit(1); }
const seeded = snap.promote();
if (!seeded.ok) { console.error(seeded.error); process.exit(1); }
console.log("seed/snapshot.json  " + Math.round(seeded.bytes / 1024) + " KB  din " + seeded.at);
