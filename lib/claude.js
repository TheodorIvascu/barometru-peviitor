"use strict";
/**
 * lib/claude.js - the single place that talks to the model gateway.
 *
 * Both callers use it:
 *   - server/assistant.js  (the chat tool-use loop)
 *   - lib/judge.js         (the "judge" rule tier: model adjudicates a small,
 *                           deterministically produced candidate set)
 *
 * Credentials come from .env at the project root: ANTHROPIC_BASE_URL and
 * ANTHROPIC_AUTH_TOKEN. Nothing here reads process.env for the token, so a
 * stray shell variable can never silently redirect our traffic.
 *
 * MEASURED on this gateway (2026-08-25, see ANALIZA-AI.md):
 *   - a round-trip costs ~20-30 s regardless of prompt size; input tokens are
 *     almost free, latency tracks output tokens and per-request overhead
 *   - `stream: true` is accepted but the gateway BUFFERS: the first SSE chunk
 *     arrives at the same moment the last one does. Streaming is still used
 *     for chat because it costs nothing and will start paying the moment the
 *     gateway forwards chunks properly, but do not expect a TTFT win today.
 */
const fs = require("fs");
const path = require("path");

function loadEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch { /* no .env - callers get a clear error on first use */ }
  return out;
}

const ENV = loadEnv();
const BASE = (ENV.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
const TOKEN = ENV.ANTHROPIC_AUTH_TOKEN || ENV.ANTHROPIC_API_KEY || "";
const DEFAULT_MODEL = ENV.ASSISTANT_MODEL || "claude-opus-5";

const headers = () => ({
  Authorization: "Bearer " + TOKEN,
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
});

function assertToken() {
  if (!TOKEN) throw new Error("lipseste ANTHROPIC_AUTH_TOKEN in .env");
}

/**
 * One non-streaming request. Returns the raw Messages API response.
 * @param {object} body model/messages/system/tools/max_tokens
 * @param {object} opts { timeoutMs }
 */
async function messages(body, opts = {}) {
  assertToken();
  // the daily allowance is enforced in lib/llm.js; charge it here too so the
  // judge tier, which calls this helper directly, cannot slip past the budget
  const llm = require(require("path").join(__dirname, "llm.js"));
  llm.assertBudget();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 180000);
  try {
    const res = await fetch(BASE + "/v1/messages", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: DEFAULT_MODEL, max_tokens: 4096, ...body }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("gateway " + res.status + ": " + (await res.text()).slice(0, 300));
    const out = await res.json();
    llm.chargeBudget("claude", {
      input: (out.usage && out.usage.input_tokens) || 0,
      output: (out.usage && out.usage.output_tokens) || 0,
    });
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One streaming request. Calls onEvent for every SSE event and resolves with
 * the assembled message ({ content, stop_reason, usage }), so a caller can use
 * the same result shape as messages().
 */
async function stream(body, onEvent, opts = {}) {
  assertToken();
  const llm = require(require("path").join(__dirname, "llm.js"));
  llm.assertBudget();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 180000);
  try {
    const res = await fetch(BASE + "/v1/messages", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: DEFAULT_MODEL, max_tokens: 4096, ...body, stream: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("gateway " + res.status + ": " + (await res.text()).slice(0, 300));

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const blocks = [];          // assembled content blocks, in order
    let stopReason = null, usage = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }

        if (ev.type === "content_block_start") {
          const b = ev.content_block;
          blocks[ev.index] = b.type === "text"
            ? { type: "text", text: "" }
            : { type: b.type, id: b.id, name: b.name, input: {}, _json: "" };
        } else if (ev.type === "content_block_delta") {
          const b = blocks[ev.index];
          if (!b) continue;
          if (ev.delta.type === "text_delta") {
            b.text += ev.delta.text;
            onEvent && onEvent({ type: "text_delta", text: ev.delta.text });
          } else if (ev.delta.type === "input_json_delta") {
            b._json += ev.delta.partial_json || "";
          }
        } else if (ev.type === "content_block_stop") {
          const b = blocks[ev.index];
          if (b && b.type === "tool_use") {
            try { b.input = b._json ? JSON.parse(b._json) : {}; } catch { b.input = {}; }
            delete b._json;
          }
        } else if (ev.type === "message_delta") {
          if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
          if (ev.usage) usage = ev.usage;
        } else if (ev.type === "error") {
          throw new Error("gateway stream error: " + JSON.stringify(ev.error).slice(0, 200));
        }
      }
    }
    return { content: blocks.filter(Boolean), stop_reason: stopReason, usage };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { messages, stream, BASE, DEFAULT_MODEL, hasToken: () => !!TOKEN };
