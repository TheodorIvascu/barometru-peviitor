"use strict";
/** Minimal Solr client for the local peviitor stack. */

// load .env here so every consumer - server, CLI script, spawned child -
// talks to the same Solr without having to remember to load it first
const ENV = require(require("path").join(__dirname, "env.js")).load();

const DEFAULTS = {
  base: ENV.SOLR_BASE || process.env.SOLR_BASE || "http://localhost:8983/solr",
  core: process.env.SOLR_CORE || "job",
  user: process.env.SOLR_USER || "solr",
  // never a literal here: the production password comes from the environment
  pass: ENV.SOLR_PASS || process.env.SOLR_PASS || "",
};

class Solr {
  constructor(opts = {}) {
    const c = { ...DEFAULTS, ...opts };
    this.base = c.base;
    this.core = c.core;
    this.url = `${c.base}/${c.core}`;
    this.auth = "Basic " + Buffer.from(`${c.user}:${c.pass}`).toString("base64");
  }

  async _get(pathAndQuery) {
    const r = await fetch(`${this.url}${pathAndQuery}`, { headers: { Authorization: this.auth } });
    if (!r.ok) throw new Error(`Solr GET ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }

  async _post(body, params = "") {
    const r = await fetch(`${this.url}/update?${params}&wt=json`, {
      method: "POST",
      headers: { Authorization: this.auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Solr POST ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }

  /** true if Solr answers at all */
  async ping() {
    try { await this._get(`/select?q=*:*&rows=0&wt=json`); return true; }
    catch { return false; }
  }

  async count(q = "*:*") {
    const j = await this._get(`/select?q=${encodeURIComponent(q)}&rows=0&wt=json`);
    return j.response.numFound;
  }

  async sample(q, fl, rows = 10) {
    const j = await this._get(`/select?q=${encodeURIComponent(q)}&fl=${encodeURIComponent(fl)}&rows=${rows}&wt=json`);
    return j.response.docs;
  }

  /** facet on a field -> [{value,count}] */
  async facet(field, q = "*:*", limit = 20) {
    const j = await this._get(`/select?q=${encodeURIComponent(q)}&rows=0&facet=true&facet.field=${encodeURIComponent(field)}&facet.limit=${limit}&facet.mincount=1&wt=json`);
    const arr = j.facet_counts.facet_fields[field] || [];
    const out = [];
    for (let i = 0; i < arr.length; i += 2) out.push({ value: arr[i], count: arr[i + 1] });
    return out;
  }

  /** stream every doc matching q, page by page, via cursorMark */
  async *scan(q, fl, page = 1000, sort = "url asc") {
    let cursor = "*";
    for (;;) {
      const j = await this._get(`/select?q=${encodeURIComponent(q)}&fl=${encodeURIComponent(fl)}&rows=${page}&sort=${encodeURIComponent(sort)}&cursorMark=${encodeURIComponent(cursor)}&wt=json`);
      const docs = j.response.docs;
      if (!docs.length) return;
      for (const d of docs) yield d;
      if (j.nextCursorMark === cursor) return;
      cursor = j.nextCursorMark;
    }
  }

  async fields() { return (await this._get(`/schema/fields?wt=json`)).fields; }
  async uniqueKey() { return (await this._get(`/schema/uniquekey?wt=json`)).uniqueKey; }

  async addField(name, type = "boolean") {
    const r = await fetch(`${this.url}/schema`, {
      method: "POST",
      headers: { Authorization: this.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ "add-field": { name, type, stored: true, indexed: true, multiValued: false } }),
    });
    return (await r.json()).responseHeader.status === 0;
  }

  /** atomic partial updates - never clobbers untouched fields */
  // ---- writes are refused, always -------------------------------------
  // This tool reads production. It FINDS problems; it does not fix them, and
  // it must never be the reason peviitor.ro loses a document. Everything we
  // derive lives in cache/ beside the index, never inside it.
  _refuseWrite(op) {
    throw new Error(
      "scriere refuzata (" + op + "): Data Quality Checker este read-only. " +
      "Datele derivate se scriu in cache/, nu in Solr."
    );
  }
  update() { this._refuseWrite("update"); }
  deleteByQuery() { this._refuseWrite("deleteByQuery"); }
  commit() { this._refuseWrite("commit"); }
  addField() { this._refuseWrite("addField"); }
}

module.exports = { Solr };
