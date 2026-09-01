"use strict";
/**
 * lib/llm.js - one call shape over several providers.
 *
 * Different jobs deserve different models, and the cheapest one that does the
 * job well is the right one:
 *
 *   gemini  - bulk classification (COR). Free tier, fast, and the task is
 *             "pick one of these codes", which needs no eloquence.
 *   claude  - the dashboard bulletin. Prose a human reads, in Romanian.
 *   groq    - reserved; slot in the same shape when a key exists.
 *
 * Every provider returns { text, tokens:{input,output}, provider, model } so a
 * caller never branches on who answered. Failures are returned, never thrown as
 * a surprise, and a provider that is overloaded (503) can fall back.
 */
const path = require("path");
const ENV = require(path.join(__dirname, "env.js")).load();

const pick = (...names) => {
  for (const n of names) {
    const v = ENV[n] || process.env[n];
    if (v) return v;
  }
  return "";
};

// ---------------------------------------------------------------------------
// daily budget
//
// Every model call in the app goes through ask()/askBalanced(), so counting
// here is the only place that cannot be bypassed by a new feature forgetting
// to check. One full pass per day is the intent: the caches make repeat runs
// nearly free anyway, and a runaway loop would otherwise burn three free tiers
// in an afternoon.
// ---------------------------------------------------------------------------
const fs = require("fs");
const BUDGET_FILE = path.join(__dirname, "..", "cache", "llm_budget.json");
const DAILY_CALLS = Number(pick("LLM_DAILY_CALLS") || 120);

const today = () => new Date().toISOString().slice(0, 10);

function readBudget() {
  try {
    const j = JSON.parse(fs.readFileSync(BUDGET_FILE, "utf8"));
    if (j.day === today()) return j;
  } catch { /* first run */ }
  return { day: today(), calls: 0, tokensIn: 0, tokensOut: 0, byProvider: {} };
}

function writeBudget(b) {
  try {
    fs.mkdirSync(path.dirname(BUDGET_FILE), { recursive: true });
    fs.writeFileSync(BUDGET_FILE, JSON.stringify(b), "utf8");
  } catch { /* a budget we cannot persist is still enforced in this process */ }
}

function budgetStatus() {
  const b = readBudget();
  return {
    day: b.day,
    used: b.calls,
    limit: DAILY_CALLS,
    left: Math.max(0, DAILY_CALLS - b.calls),
    tokens: { input: b.tokensIn, output: b.tokensOut },
    byProvider: b.byProvider,
    exhausted: b.calls >= DAILY_CALLS,
  };
}

/** throws when the day's allowance is gone; callers report it, never retry */
function chargeBudget(provider, tokens) {
  const b = readBudget();
  b.calls += 1;
  b.tokensIn += (tokens && tokens.input) || 0;
  b.tokensOut += (tokens && tokens.output) || 0;
  b.byProvider[provider] = (b.byProvider[provider] || 0) + 1;
  writeBudget(b);
}

function assertBudget() {
  const b = readBudget();
  if (b.calls >= DAILY_CALLS) {
    const e = new Error(
      "buget AI epuizat pentru azi (" + b.calls + "/" + DAILY_CALLS + "). Se reia maine."
    );
    e.budgetExhausted = true;
    throw e;
  }
}

const PROVIDERS = {
  gemini: {
    key: () => pick("GEMINI_API_KEY"),
    model: () => pick("GEMINI_MODEL") || "gemini-flash-lite-latest",
    async call({ system, user, maxTokens, model }) {
      const m = model || this.model();
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + m + ":generateContent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-goog-api-key": this.key() },
          body: JSON.stringify({
            systemInstruction: system ? { parts: [{ text: system }] } : undefined,
            contents: [{ parts: [{ text: user }] }],
            generationConfig: { maxOutputTokens: maxTokens || 1500, temperature: 0 },
          }),
        }
      );
      const body = await res.text();
      if (!res.ok) {
        const err = new Error("gemini " + res.status + ": " + body.slice(0, 180));
        err.status = res.status;
        throw err;
      }
      const j = JSON.parse(body);
      const cand = (j.candidates || [])[0];
      const text = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || "").join("");
      const u = j.usageMetadata || {};
      return {
        text: String(text).trim(),
        tokens: { input: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0 },
        provider: "gemini", model: m,
      };
    },
  },

  claude: {
    key: () => pick("ANTHROPIC_AUTH_TOKEN"),
    model: () => pick("CLAUDE_MODEL") || "claude-sonnet-5",
    base: () => (pick("ANTHROPIC_BASE_URL") || "https://api.anthropic.com").replace(/\/+$/, ""),
    async call({ system, user, maxTokens, model }) {
      const m = model || this.model();
      const res = await fetch(this.base() + "/v1/messages", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + this.key(),
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: m,
          max_tokens: maxTokens || 1000,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      const body = await res.text();
      if (!res.ok) {
        const err = new Error("claude " + res.status + ": " + body.slice(0, 180));
        err.status = res.status;
        throw err;
      }
      const j = JSON.parse(body);
      const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      const u = j.usage || {};
      return {
        text: String(text).trim(),
        tokens: { input: u.input_tokens || 0, output: u.output_tokens || 0 },
        provider: "claude", model: m,
      };
    },
  },

  groq: {
    key: () => pick("GROQ_API_KEY"),
    model: () => pick("GROQ_MODEL") || "llama-3.3-70b-versatile",
    async call({ system, user, maxTokens, model }) {
      const m = model || this.model();
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + this.key(), "Content-Type": "application/json" },
        body: JSON.stringify({
          model: m,
          max_tokens: maxTokens || 1500,
          temperature: 0,
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: user },
          ],
        }),
      });
      const body = await res.text();
      if (!res.ok) {
        const err = new Error("groq " + res.status + ": " + body.slice(0, 180));
        err.status = res.status;
        throw err;
      }
      const j = JSON.parse(body);
      const text = ((j.choices || [])[0] || {}).message?.content || "";
      const u = j.usage || {};
      return {
        text: String(text).trim(),
        tokens: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 },
        provider: "groq", model: m,
      };
    },
  },
};

/** which providers actually have a key right now */
function available() {
  return Object.keys(PROVIDERS).filter((p) => !!PROVIDERS[p].key());
}

/**
 * Ask the first provider in `order` that has a key. Falls through to the next
 * on 429/503 (rate limited / overloaded) — the free tiers do that regularly.
 */
async function ask({ system, user, maxTokens, order = ["gemini", "claude", "groq"], model }) {
  assertBudget();
  const tried = [];
  for (const name of order) {
    const p = PROVIDERS[name];
    if (!p || !p.key()) { tried.push(name + ":fara cheie"); continue; }
    try {
      const out = await p.call({ system, user, maxTokens, model: name === (order[0]) ? model : undefined });
      chargeBudget(out.provider, out.tokens);
      return out;
    } catch (e) {
      tried.push(name + ":" + (e.status || "eroare"));
      if (e.status && e.status !== 429 && e.status !== 503 && e.status !== 500) throw e;
    }
  }
  throw new Error("niciun furnizor disponibil (" + tried.join(", ") + ")");
}

/**
 * Round-robin across every provider that has a key.
 *
 * Three free tiers are three separate quotas. A bulk run that hammers one of
 * them gets rate-limited halfway through; spreading the calls means all three
 * stay under their limit and the run finishes. Each call still falls through to
 * the others if the one whose turn it is refuses.
 */
let rrCursor = 0;
async function askBalanced({ system, user, maxTokens, only }) {
  assertBudget();
  const pool = (only && only.length ? only : ["gemini", "groq", "claude"]).filter(
    (p) => PROVIDERS[p] && PROVIDERS[p].key()
  );
  if (!pool.length) throw new Error("niciun furnizor are cheie");

  const start = rrCursor % pool.length;
  rrCursor++;
  const order = pool.slice(start).concat(pool.slice(0, start));
  return ask({ system, user, maxTokens, order });
}

module.exports = { ask, askBalanced, available, PROVIDERS, budgetStatus, assertBudget, chargeBudget, DAILY_CALLS };
