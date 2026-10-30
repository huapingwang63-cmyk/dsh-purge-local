#!/usr/bin/env node
// One-shot entry point: bring up a browser-controllable DSH Web instance and
// hand back everything needed to drive it.
//
//   node dsh-gui.mjs                 -> human summary
//   node dsh-gui.mjs --json          -> machine-readable
//   node dsh-gui.mjs --stop          -> kill the helper
//   node dsh-gui.mjs --status        -> is it alive?
//
// Why a helper instance at all: the host Electron GUI on 50501 never runs the
// HTTP cookie exchange, so its browser session cannot be forged or observed.
// A `dsh web` helper is the same application served over HTTP, and there the
// auth flow is fully modelled (token -> 303 + Set-Cookie, or an offline-forged
// cookie minted from $DSH_HOME/.credentials.yaml).
//
// Architecture rules encoded here (each learned the hard way):
//   1. stdout must go to a FILE, not a pipe: a pipe dies with the parent, and
//      the launch URL is the only place the helper reveals its REAL port.
//      Guessing a port is wrong — a helper that loses a port race serves 404.
//   2. detached:true + stdio:["ignore", fd, fd] so the helper outlives this
//      process.
//   3. The forged cookie must carry the exact `host:port` authority the helper
//      bound, or the HMAC check is against a different cookie name and 401s.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync, writeFileSync, existsSync, unlinkSync, openSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import http from "node:http";

const DIR = "C:\\Users\\Mr.Wang\\.dsh\\dsh-purge\\heal";
const LOG = DIR + "\\gui-helper.log";
const STATE = DIR + "\\gui-helper.json";
const CREDS = "C:\\Users\\Mr.Wang\\.dsh\\.credentials.yaml";
const NODE = "C:\\Users\\Mr.Wang\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe";
const BIN = "C:\\Users\\Mr.Wang\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
const URL_RE = /dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+))/;
const DAY = 86400000;

const argv = new Set(process.argv.slice(2));
const wantJson = argv.has("--json");

const b64url = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const decodeSecret = (s) => Buffer.from(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4), "base64");

const alive = () => {
  if (!existsSync(STATE)) return null;
  try {
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    process.kill(st.pid, 0);
    return st;
  } catch { return null; }
};

if (argv.has("--stop")) {
  const st = alive();
  if (st) { try { process.kill(st.pid); } catch {} try { unlinkSync(STATE); } catch {} }
  console.log(JSON.stringify({ stopped: st?.pid ?? null }));
  process.exit(0);
}

const probe = (port, cookie) => new Promise((resolve) => {
  const r = http.request({ host: "127.0.0.1", port, path: "/", method: "GET", headers: cookie ? { Cookie: cookie } : {}, timeout: 15000 }, (res) => {
    let n = 0; res.on("data", (d) => (n += d.length));
    res.on("end", () => resolve({ status: res.statusCode, len: n }));
  });
  r.on("error", () => resolve({ status: 0 })); r.on("timeout", () => { r.destroy(); resolve({ status: 0 }); }); r.end();
});

if (argv.has("--status")) {
  const st = alive();
  if (!st) { console.log(JSON.stringify({ alive: false })); process.exit(1); }
  const p = await probe(st.port);
  console.log(JSON.stringify({ alive: p.status === 401, ...st, probeStatus: p.status }, null, 2));
  process.exit(p.status === 401 ? 0 : 1);
}

// ---- bring the helper up (reuse if already healthy) ----
let st = alive();
let p, token, reused = false;

if (st) {
  const h = await probe(st.port);
  if (h.status === 401) { p = st.port; token = URL_RE.exec(readFileSync(LOG, "utf8"))?.[3] ?? null; reused = true; }
  else { try { process.kill(st.pid); } catch {} st = null; }
}

if (!st) {
  const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const q = s.address().port; s.close(() => res(q)); }); });
  const port = await freePort();
  writeFileSync(LOG, "");
  const fd = openSync(LOG, "w");
  const child = spawn(NODE, [BIN, "web", "--port", String(port), "--no-open"], { stdio: ["ignore", fd, fd], detached: true, windowsHide: true });
  child.unref();

  let m = null;
  for (let i = 0; i < 160; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { m = URL_RE.exec(readFileSync(LOG, "utf8")); } catch {}
    if (m) break;
  }
  if (!m) { try { process.kill(child.pid); } catch {} process.stderr.write("dsh-gui: helper never printed a launch URL\n" + (existsSync(LOG) ? readFileSync(LOG, "utf8").slice(-600) : "")); process.exit(3); }
  p = Number(m[2]);
  token = m[3];
  const ready = await probe(p);
  if (ready.status !== 401) { try { process.kill(child.pid); } catch {} process.stderr.write("dsh-gui: port " + p + " is not the DSH listener (probe " + ready.status + ")\n"); process.exit(3); }
  st = { port: p, pid: child.pid, url: m[1], log: LOG, startedAt: Date.now() };
  writeFileSync(STATE, JSON.stringify(st, null, 2));
}

// ---- mint the cookie for the authority the helper actually bound ----
const authority = `127.0.0.1:${p}`;
const stored = /client-connection\/browser-session[\s\S]*?secret:\s*(\S+)/.exec(readFileSync(CREDS, "utf8"))[1];
const key = decodeSecret(stored);
if (key.length !== 32) { process.stderr.write("dsh-gui: decoded secret is " + key.length + " bytes, expected 32\n"); process.exit(2); }

const cookieName = "dsh-auth-" + b64url(createHash("sha256").update(authority).digest());
const now = Date.now(), exp = now + 30 * DAY;
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: exp }), "utf8"));
const sig = b64url(createHmac("sha256", key).update(body).digest());
const pair = `${cookieName}=v1.${body}.${sig}`;

const verified = await probe(p, pair);
if (verified.status !== 200) {
  process.stderr.write("dsh-gui: forged cookie rejected (" + verified.status + ") on " + authority + "\n");
  process.exit(3);
}

const base = `http://127.0.0.1:${p}`;
const out = {
  baseUrl: base,
  authority,
  port: p,
  pid: st.pid,
  reused,
  token,
  launchUrl: token ? `${base}/?token=${token}` : null,
  cookieName,
  cookiePair: pair,
  cookieHeader: pair,
  expiresAtIso: new Date(exp).toISOString(),
  verified,
  playbook: [
    `node dsh-gui.mjs --json`,
    `browser_navigate ${base}/?token=${token ?? "<token>"}`,
    `# or seed the cookie first:`,
    `browser_run_code_unsafe { page.context().addCookies([{ name: "${cookieName}", value: pair.split("=").slice(1).join("="), domain: "127.0.0.1", path: "/", httpOnly: true }]) }`,
    `browser_navigate ${base}/`,
  ],
};
writeFileSync(DIR + "\\gui-session.json", JSON.stringify(out, null, 2));

if (wantJson) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`baseUrl      ${out.baseUrl}`);
  console.log(`launchUrl    ${out.launchUrl}`);
  console.log(`cookieName   ${out.cookieName}`);
  console.log(`cookiePair   ${out.cookiePair}`);
  console.log(`verified     HTTP ${out.verified.status}, ${out.verified.len} bytes`);
  console.log(`reused       ${out.reused}`);
}
process.exit(0);