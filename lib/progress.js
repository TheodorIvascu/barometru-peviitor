"use strict";
/** Single-line terminal progress bar: [#####-----]  42.1%  1,737/4,126  327/s  eta 7s */
class Progress {
  constructor(total, label) {
    this.total = Math.max(total || 0, 1);
    this.label = label || "working";
    this.n = 0;
    this.t0 = Date.now();
    this.last = 0;
    this.tty = process.stdout.isTTY !== false;
    this.width = 34;
  }
  tick(step) {
    this.n += step || 1;
    const now = Date.now();
    if (now - this.last < 80 && this.n < this.total) return;
    this.last = now;
    this.render();
  }
  render() {
    const frac = Math.min(this.n / this.total, 1);
    const filled = Math.round(frac * this.width);
    const bar = "#".repeat(filled) + "-".repeat(this.width - filled);
    const secs = (Date.now() - this.t0) / 1000;
    const rate = this.n / Math.max(secs, 0.001);
    const eta = rate > 0 ? Math.max(0, (this.total - this.n) / rate) : 0;
    const txt =
      "  " + this.label.padEnd(12) +
      "[" + bar + "] " +
      (frac * 100).toFixed(1).padStart(5) + "%  " +
      this.n.toLocaleString("en-US") + "/" + this.total.toLocaleString("en-US") +
      "  " + Math.round(rate).toLocaleString("en-US") + "/s" +
      "  eta " + (eta < 1 ? "0" : Math.ceil(eta)) + "s";
    if (this.tty) process.stdout.write("\r" + txt + "   ");
    else if (this.n >= this.total) process.stdout.write(txt + "\n");
  }
  done(msg) {
    this.n = this.total;
    this.render();
    const secs = (Date.now() - this.t0) / 1000;
    if (this.tty) process.stdout.write("\n");
    if (msg) console.log("  " + msg + " in " + secs.toFixed(1) + "s");
  }
}
module.exports = { Progress };
