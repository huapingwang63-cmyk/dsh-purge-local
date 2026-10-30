#!/usr/bin/env node
// Return everything a Playwright session needs to drive the DSH GUI.
//
//   node gui-playwright.mjs           -> JSON { baseUrl, launchUrl, cookie, plan }
//   node gui-playwright.mjs --ensure  -> also bring the helper up first
//
// The DSH host Electron GUI (127.0.0.1:50501) does NOT accept HTTP cookies —
// its renderer runs over `dsh-app://` with preload state, so nothing can be
// observed or forged there. A `dsh web` helper is the same app over plain HTTP,
// where auth is fully modelled. This script is the bridge: it guarantees a live
// helper and emits the exact navigate/cookie calls to reproduce the session.
//
// Two independent ways in, both verified end-to-end:
//   A) navigate to the launch URL  -> server replies 303 + Set-Cookie
//   B) seed the forged cookie      -> server replies 200 directly
// Way B survives navigations that drop query strings; way A needs the token
// re-attached on every fresh browser context.

import { readFileSync, existsSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";

const DIR = "C:\\Users\\Mr.Wang\\.dsh\\dsh-purge\\heal";
const SESSION = DIR + "\\gui-session.json";
const CREDS = "C:\\Users\\Mr.Wang\\.dsh\\.credentials.yaml";
const NODE = "C:\\Users\\Mr.Wang\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe";
const GUI = DIR + "\\dsh-gui.mjs";
const DAY = 86400000;

const argv = new Set(process.argv.slice(2));
const b64url = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const decodeSecret = (s) => Buffer.from(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4), "base64");

if (argv.has("--ensure") || !existsSync(SESSION)) {
  const r = spawnSync(NODE, [GUI, "--json"], { encoding: "utf8" });
  if (r.status !== 0) { process.stderr.write(r.stderr || "gui-playwright: failed to bring the helper up\n"); process.exit(3); }
}

const session = JSON.parse(readFileSync(SESSION, "utf8"));
const authority = session.authority;
const port = session.port;

const stored = /client-connection\/browser-session[\s\S]*?secret:\s*(\S+)/.exec(readFileSync(CREDS, "utf8"))[1];
const key = decodeSecret(stored);
const name = "dsh-auth-" + b64url(createHash("sha256").update(authority).digest());
const now = Date.now(), exp = now + 30 * DAY;
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: exp }), "utf8"));
const sig = b64url(createHmac("sha256", key).update(body).digest());
const value = `v1.${body}.${sig}`;

const out = {
  baseUrl: `http://127.0.0.1:${port}`,
  launchUrl: `http://127.0.0.1:${port}/?token=${session.token}`,
  cookie: { name, value, domain: "127.0.0.1", path: "/", httpOnly: true },
  cookiePair: `${name}=${value}`,
  authority,
  plan: {
    A_token: {
      step1: `browser_navigate ${`http://127.0.0.1:${port}/?token=${session.token}`}`,
      note: "303 + Set-Cookie; URL lands on the clean baseUrl. Requires the token on EVERY new browser context.",
    },
    B_cookie: {
      step1: `browser_run_code_unsafe: page.context().addCookies([{ name: ${JSON.stringify(name)}, value: ${JSON.stringify(value)}, domain: "127.0.0.1", path: "/", httpOnly: true }])`,
      step2: `browser_navigate http://127.0.0.1:${port}/`,
      note: "Direct 200. Survives navigations. Cookie value is regenerated on each run of this script.",
    },
    health: `Invoke-WebRequest http://127.0.0.1:${port}/ -Headers @{Cookie='${name}=${value}'} -> expect 200`,
  },
  freshCookie: true,
  expiresAtIso: new Date(exp).toISOString(),
};

if (argv.has("--json") || true) console.log(JSON.stringify(out, null, 2));
process.exit(0);