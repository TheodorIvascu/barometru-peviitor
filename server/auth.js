"use strict";
/**
 * server/auth.js — login page + signed session cookie.
 *
 * The app carries four API keys and the production Solr password in its
 * process, so it must not be open to the internet. Basic auth would do that
 * job, but it hands the user the browser's grey system dialog; this serves a
 * proper page in the app's own design instead.
 *
 * Off when BAROMETRU_PASSWORD is unset, so local work stays frictionless — and
 * the server says at startup which mode it is in, so an unprotected deployment
 * cannot happen quietly.
 */
const crypto = require("crypto");
const path = require("path");

const COOKIE = "barometru_sesiune";

/**
 * Public mode: anyone may LOOK, only a signed-in person may spend.
 *
 * The site is meant to be shared, but the process holds four API keys and the
 * production Solr password. Reading costs nothing and writes to Solr are
 * refused in lib/solr.js anyway — so browsing is open, while anything that
 * calls a model or starts a scan needs the password. Set BAROMETRU_PUBLIC=0 to
 * lock the whole site instead.
 */
const PROTECTED = [
  "/api/pipeline",          // full re-analysis
  "/api/classify",
  "/api/materialize",
  "/api/cor",               // POST only; the GET below stays public
  "/api/cor/ai",
  "/api/judge",
  "/api/ai/locations",
  "/api/sources/diagnose",
  "/api/peviitor/open",     // launches a browser on the host
  "/api/chat",
  "/api/chat/stream",
];

function isPublicMode() {
  const ENV = require(path.join(__dirname, "..", "lib", "env.js")).load();
  return String(ENV.BAROMETRU_PUBLIC ?? process.env.BAROMETRU_PUBLIC ?? "1") !== "0";
}

/** a costly action is any POST, plus the few GETs that trigger model calls */
function costs(method, pathname) {
  if (method !== "POST") {
    // regenerating the bulletin is a model call even though it is a GET
    return pathname === "/api/summary" && false;
  }
  return PROTECTED.some((p) => pathname === p);
}
const MAX_AGE = 60 * 60 * 24 * 14;             // two weeks

function conf() {
  const ENV = require(path.join(__dirname, "..", "lib", "env.js")).load();
  const pass = ENV.BAROMETRU_PASSWORD || process.env.BAROMETRU_PASSWORD || "";
  return {
    user: ENV.BAROMETRU_USER || process.env.BAROMETRU_USER || "peviitor",
    pass,
    // the cookie is signed with the password, so changing it logs everyone out
    secret: ENV.BAROMETRU_SECRET || process.env.BAROMETRU_SECRET || pass,
  };
}

const enabled = () => !!conf().pass;

/** constant-time compare so a password cannot be guessed byte by byte */
function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}

function sign(value) {
  return crypto.createHmac("sha256", conf().secret).update(String(value)).digest("hex").slice(0, 32);
}

function makeToken() {
  const exp = Date.now() + MAX_AGE * 1000;
  return exp + "." + sign(exp);
}

function validToken(t) {
  const [exp, sig] = String(t || "").split(".");
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  return same(sig, sign(exp));
}

function readCookie(req) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on("end", () => resolve(raw));
  });
}

function page({ error } = {}) {
  return `<!DOCTYPE html>
<html lang="ro" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BAROMETRU · autentificare</title>
<link rel="stylesheet" href="/style.css">
<style>
  .login-wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
  .login-card { width: 100%; max-width: 380px; }
  .login-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 26px; }
  .login-field { margin-bottom: 14px; }
  .login-field label { display: block; font-size: .82rem; color: var(--text-muted); margin-bottom: 6px; font-weight: 600; }
  .login-field input {
    width: 100%; background: var(--bg-base); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm); padding: 11px 14px; color: var(--text-main);
    font: inherit; font-size: .95rem;
  }
  .login-field input:focus { outline: none; border-color: var(--color-blue); box-shadow: 0 0 0 3px var(--bg-blue-soft); }
  .login-btn { width: 100%; justify-content: center; margin-top: 6px; border-color: var(--color-blue); color: var(--color-blue); }
  .login-err {
    background: var(--bg-red-soft); border: 1px solid var(--color-red); color: var(--color-red);
    padding: 10px 14px; border-radius: var(--radius-sm); font-size: .88rem; margin-bottom: 16px;
  }
  .login-note { margin-top: 18px; font-size: .78rem; color: var(--text-subtle); text-align: center; line-height: 1.6; }
</style>
</head>
<body>
  <div class="login-wrap">
    <div class="card login-card">
      <div class="login-brand">
        <div class="brand-icon" aria-hidden="true">&#127777;</div>
        <div class="brand-text">
          <h1>BAROMETRU</h1>
          <p>starea datelor &middot; peviitor.ro</p>
        </div>
      </div>
      ${error ? '<div class="login-err">' + error + "</div>" : ""}
      <form method="POST" action="/login">
        <div class="login-field">
          <label for="u">Utilizator</label>
          <input id="u" name="user" autocomplete="username" autofocus value="${conf().user}">
        </div>
        <div class="login-field">
          <label for="p">Parolă</label>
          <input id="p" name="password" type="password" autocomplete="current-password">
        </div>
        <button class="btn login-btn" type="submit">Intră</button>
      </form>
      <div class="login-note">Instrument intern. Citește indexul de producție, nu îl modifică.</div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Handles /login itself and gates everything else.
 * @returns {Promise<boolean>} true when the request may continue
 */
async function gate(req, res, url) {
  if (!enabled()) return true;

  // the stylesheet has to load on the login page itself
  if (url.pathname === "/style.css") return true;

  const authed = validToken(readCookie(req));

  if (url.pathname === "/login") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const { user, pass } = conf();
      if (same(params.get("user") || "", user) && same(params.get("password") || "", pass)) {
        res.writeHead(302, {
          "Set-Cookie": COOKIE + "=" + encodeURIComponent(makeToken())
            + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + MAX_AGE
            + (req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""),
          Location: "/",
        });
        res.end();
        return false;
      }
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(page({ error: "Utilizator sau parolă greșită." }));
      return false;
    }
    if (authed) { res.writeHead(302, { Location: "/" }); res.end(); return false; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(page());
    return false;
  }

  if (url.pathname === "/logout") {
    res.writeHead(302, { "Set-Cookie": COOKIE + "=; Path=/; HttpOnly; Max-Age=0", Location: "/login" });
    res.end();
    return false;
  }

  if (authed) return true;

  // public mode: looking is free, spending is not
  if (isPublicMode() && !costs(req.method, url.pathname)) return true;

  // an API call gets JSON, a browser gets the login page
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "neautentificat", login: "/login" }));
    return false;
  }
  res.writeHead(302, { Location: "/login" });
  res.end();
  return false;
}

function describe() {
  if (!enabled()) return "FĂRĂ PAROLĂ — setează BAROMETRU_PASSWORD înainte de a-l expune public";
  return isPublicMode()
    ? "public la citire; acțiunile care costă cer parolă (utilizator: " + conf().user + ")"
    : "complet protejat cu parolă (utilizator: " + conf().user + ")";
}

/** the UI asks this to know whether to show or gate the expensive buttons */
function status(req) {
  return {
    protejat: enabled(),
    public: isPublicMode(),
    autentificat: !enabled() || validToken(readCookie(req)),
  };
}

module.exports = { gate, enabled, describe, status, COOKIE };
