"use strict";
/**
 * Token-bucket rate limiter + bounded-concurrency queue.
 * Used for every outbound call to a third party (ANAF, job sites) so we
 * stay inside their published limits and never hammer anyone.
 */
class RateLimiter {
  /**
   * @param {number} perSecond  max requests started per second
   * @param {number} concurrency max requests in flight at once
   */
  constructor(perSecond = 1, concurrency = 1) {
    this.interval = 1000 / perSecond;
    this.concurrency = Math.max(1, concurrency);
    this.queue = [];
    this.active = 0;
    this.last = 0;
    this.stats = { done: 0, failed: 0, retried: 0, waitedMs: 0 };
  }

  /** run fn() when a slot and a token are free; returns fn's promise */
  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._pump();
    });
  }

  async _pump() {
    if (this.active >= this.concurrency || !this.queue.length) return;
    const now = Date.now();
    const wait = Math.max(0, this.last + this.interval - now);
    if (wait > 0) {
      this.stats.waitedMs += wait;
      setTimeout(() => this._pump(), wait);
      return;
    }
    const job = this.queue.shift();
    this.last = Date.now();
    this.active++;
    try {
      const r = await job.fn();
      this.stats.done++;
      job.resolve(r);
    } catch (e) {
      this.stats.failed++;
      job.reject(e);
    } finally {
      this.active--;
      this._pump();
    }
  }

  get pending() { return this.queue.length + this.active; }
}

/** fetch with timeout, retry and exponential backoff; honours Retry-After */
async function fetchRetry(url, opts = {}, cfg = {}) {
  const { retries = 2, timeoutMs = 10000, backoffMs = 800, onRetry } = cfg;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ac.signal });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) {
        const ra = parseInt(res.headers.get("retry-after") || "0", 10);
        if (attempt < retries) {
          const delay = ra ? ra * 1000 : backoffMs * Math.pow(2, attempt);
          onRetry && onRetry(attempt + 1, res.status, delay);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
      return res;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (attempt < retries) {
        const delay = backoffMs * Math.pow(2, attempt);
        onRetry && onRetry(attempt + 1, e.name === "AbortError" ? "timeout" : e.message, delay);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
  }
  throw lastErr || new Error("request failed");
}

module.exports = { RateLimiter, fetchRetry };
