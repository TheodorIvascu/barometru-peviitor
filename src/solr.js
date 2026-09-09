"use strict";
/**
 * Read-only Solr client.
 *
 * This is the only file that talks to the network. It can count, facet and
 * scan. It cannot write: there is no update, delete or commit method, and the
 * three names are defined below only so that a call fails loudly instead of
 * silently doing nothing.
 */
require("./env.js").load();

const DEFAULTS = {
  base: process.env.SOLR_BASE || "https://solr.peviitor.ro/solr",
  user: process.env.SOLR_USER || "solr",
  pass: process.env.SOLR_PASS || "",
};

class Solr {
  constructor(core, opts = {}) {
    const c = { ...DEFAULTS, ...opts };
    this.core = core;
    this.url = `${c.base}/${core}`;
    this.auth = "Basic " + Buffer.from(`${c.user}:${c.pass}`).toString("base64");
  }

  async _get(pathAndQuery) {
    let r;
    try {
      r = await fetch(`${this.url}${pathAndQuery}`, { headers: { Authorization: this.auth } });
    } catch (e) {
      // "TypeError: fetch failed" nu spune nimic. Codul din cauza de dedesubt
      // spune dacă e DNS, refuz de conexiune sau expirare.
      const cause = e.cause || {};
      throw new Error("Solr (" + this.core + ") inaccesibil: " + (cause.code || cause.message || e.message));
    }
    if (!r.ok) throw new Error(`Solr GET ${this.core} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }

  async ping() {
    try { await this._get(`/select?q=*:*&rows=0&wt=json`); return true; } catch { return false; }
  }

  async count(q = "*:*") {
    const j = await this._get(`/select?q=${encodeURIComponent(q)}&rows=0&wt=json`);
    return j.response.numFound;
  }

  /** facet on a field -> [{value, count}] */
  async facet(field, q = "*:*", limit = 20) {
    const j = await this._get(`/select?q=${encodeURIComponent(q)}&rows=0&facet=true&facet.field=${encodeURIComponent(field)}&facet.limit=${limit}&facet.mincount=1&wt=json`);
    const arr = j.facet_counts.facet_fields[field] || [];
    const out = [];
    for (let i = 0; i < arr.length; i += 2) out.push({ value: arr[i], count: arr[i + 1] });
    return out;
  }

  /** every document matching q, streamed page by page through cursorMark */
  async *scan(q, fl, opts = {}) {
    const rows = opts.rows || 1000;
    const sort = opts.sort || "url asc";
    let cursor = "*";
    for (;;) {
      const j = await this._get(`/select?q=${encodeURIComponent(q)}&fl=${encodeURIComponent(fl)}&rows=${rows}&sort=${encodeURIComponent(sort)}&cursorMark=${encodeURIComponent(cursor)}&wt=json`);
      const docs = j.response.docs;
      if (!docs.length) return;
      for (const d of docs) yield d;
      if (j.nextCursorMark === cursor) return;
      cursor = j.nextCursorMark;
    }
  }

  // ---- writes do not exist here ------------------------------------------
  update() { throw new Error("BAROMETRU is read-only: it finds problems, it does not fix them"); }
  deleteByQuery() { throw new Error("BAROMETRU is read-only: it finds problems, it does not fix them"); }
  commit() { throw new Error("BAROMETRU is read-only: it finds problems, it does not fix them"); }
}

module.exports = { Solr };
