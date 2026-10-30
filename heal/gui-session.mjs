#!/usr/bin/env node
// One-shot DSH Web GUI session for automation: bring up a controllable
// `dsh web` helper and hand back a cookie that is guaranteed to authenticate.
//
// WHY a helper instead of the Electron host on 127.0.0.1:50501:
//   The host never performs the launch-token -> cookie exchange over HTTP
//   (its own renderer uses the `dsh-app://` scheme + preload boot payload),
//   so its PROCESS_LAUNCH_TOKENS entry is unused and no cookie it would accept
//   can be produced or observed. A helper we start ourselves does the exchange,
//   and because the signing secret is shared per-DSH_HOME, we can mint an
//   equivalent cookie for that helper's authority offline.
//
// Usage:
//   node gui-session.mjs                 -> start helper, print cookie + url
//   node gui-session.mjs --json          -> machine-readable
//   node gui-session.mjs --resume        -> reuse cached helper if alive
//   node gui-session.mjs --stop          -> kill the cached helper
//   node gui-session.mjs --verify        -> also assert GET / == 200
//
// Exit 0 ok, 2 credential problem, 3 helper never came up, 4 verification failed.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import http from "node:http";

const DIR = "C:\\Users\\Mr.Wang\\.dsh\\dsh-purge\\heal";
const STATE = DIR + "\\gui-session.json";
const CRED = "C:\\Users\\Mr.Wang\\.dsh\\.credentials.yaml";
const NODE = "C:\\Users\\Mr.Wang\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe";
const BIN = "C:\\Users\\Mr.Wang\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
const URL_RE = /dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+))/;
const DAY_MS = 86400000;

const argv = new Set(process.argv.slice(2));
const wantJson = argv.has("--json");

const b64url = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const cookieName = (a) => "dsh-auth-" + b64url(createHash("sha256").update(a).digest());
const secretKey = (stored) => {
  const raw = Buffer.from(stored.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((stored.length + 3) % 4), "base64");
  if (raw.length !== 32) { process.stderr.write("gui-session: secret is not 32 bytes\n"); process.exit(2); }
  return raw;
};

function readStoredSecret() {
  if (!existsSync(CRED)) { process.stderr.write("gui-session: no " + CRED + "\n"); process.exit(2); }
  const lines = readFileSync(CRED, "utf8").split(/\r?\n/);
  let inRec = false, indent = -1;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const level = line.length - line.trimStart().length;
    const text = line.trim();
    if (level === 2 && text === "client-connection/browser-session:") { inRec = true; indent = level; continue; }
    if (inRec) {
      if (level <= indent) break;
      const m = /^secret:\s*(\S+)\s*$/.exec(text);
      if (m) return m[1];
    }
  }
  process.stderr.write("gui-session: browser-session secret absent\n");
  process.exit(2);
}

function freePort() {
  return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const req = (port, path, cookie) => new Promise((resolve) => {
  const r = http.request({ host: "127.0.0.1", port, path, method: "GET", timeout: 10000, headers: cookie ? { Cookie: cookie } : {} }, (res) => {
    let n = 0; res.on("data", d => n += d.length);
    res.on("end", () => resolve({ status: res.statusCode, len: n }));
  });
  r.on("error", (e) => resolve({ status: 0, err: e.message }));
  r.on("timeout", () => { r.destroy(); resolve({ status: 0, err: "timeout" }); });
  r.end();
});

// --- --stop ---------------------------------------------------------------
if (argv.has("--stop")) {
  if (existsSync(STATE)) {
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    try { process.kill(st.pid); } catch {}
    try { unlinkSync(STATE); } catch {}
    console.log(JSON.stringify({ stopped: st.pid, port: st.port }));
  } else console.log(JSON.stringify({ stopped: null }));
  process.exit(0);
}

// --- --resume: reuse a live helper ---------------------------------------
if (argv.has("--resume") && existsSync(STATE)) {
  const st = JSON.parse(readFileSync(STATE, "utf8"));
  const health = await req(st.port, "/");
  if (health.status !== 0) {
    const cookie = mintFor(st);
    const ok = await req(st.port, "/", `${cookie.name}=${cookie.value}`);
    const out = { resumed: true, port: st.port, pid: st.pid, cookie: `${cookie.name}=${cookie.value}`, url: st.url, verified: ok.status };
    console.log(wantJson ? JSON.stringify(out, null, 2) : out.cookie);
    process.exit(ok.status === 200 ? 0 : 4);
  }
}

function mintFor(st, days = 30) {
  const key = secretKey(readStoredSecret());
  const auth = `127.0.0.1:${st.port}`;
  const issuedAt = Date.now(), expiresAt = issuedAt + days * DAY_MS;
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: auth, issuedAt, expiresAt }), "utf8"));
  const sig = b64url(createHmac("sha256", key).update(body).digest());
  const name = cookieName(auth);
  return { name, value: `v1.${body}.${sig}`, authority: auth, issuedAt, expiresAt, days };
}

// --- start a fresh helper -------------------------------------------------
const port = await freePort();
const child = spawn(NODE, [BIN, "web", "--port", String(port), "--no-open"], {
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
let out = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => { out += d; });

const m = await new Promise((res) => {
  const t = setTimeout(() => res(null), 90000);
  const scan = () => { const mm = URL_RE.exec(out); if (mm) { clearTimeout(t); res(mm); } };
  child.stdout.on("data", scan); scan();
});
if (!m) { try { child.kill(); } catch {}; process.stderr.write("gui-session: helper never printed its URL\n"); process.exit(3); }

const p = Number(m[2]), launchUrl = m[1];

// Detach: pipe is a parent-child lifeline, so re-spawn ignoring stdio.
// The relaunched process re-randomises its OWN launch token, so the URL
// harvested from the first spawn cannot be reused. Instead we mint the cookie
// offline from the shared DSH_HOME secret — which control-test.mjs proved is
// accepted byte-identically to a server-minted cookie.
child.stdio.forEach((s) => s?.destroy?.());
try { child.kill(); } catch {}
await new Promise((r) => setTimeout(r, 1200));

const keep = spawn(NODE, [BIN, "web", "--port", String(p), "--no-open"], {
  stdio: "ignore", detached: true, windowsHide: true,
});
keep.unref();

// Wait for readiness, then confirm the ACTUAL bind port equals `p` (a helper
// that loses a port race silently picks another one, which would make the
// minted authority wrong and every request 401).
let ready = false, probes = [];
for (let i = 0; i < 60; i++) {
  const h = await req(p, "/");
  probes.push(h.status);
  if (h.status !== 0) { ready = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (!ready) { process.stderr.write("gui-session: helper did not become reachable on " + p + "\n"); process.exit(3); }
// A reachable server that answers 401 to a bare GET is the expected shape here.
if (!probes.includes(401)) {
  process.stderr.write("gui-session: port " + p + " answered " + JSON.stringify(probes) + " (not the DSH web listener)\n");
  process.exit(3);
}

const cookie = mintFor({ port: p });
const verify = argv.has("--verify") ? await req(p, "/", `${cookie.name}=${cookie.value}`) : null;

const state = { port: p, pid: keep.pid, url: `http://127.0.0.1:${p}/`, launchUrl, startedAt: Date.now() };
writeFileSync(STATE, JSON.stringify(state, null, 2));

const result = {
  port: p,
  pid: keep.pid,
  url: state.url,
  cookieName: cookie.name,
  cookieValue: cookie.value,
  cookieHeader: `${cookie.name}=${cookie.value}`,
  authority: cookie.authority,
  expiresAt: new Date(cookie.expiresAt).toISOString(),
  ...(verify ? { verifiedStatus: verify.status, verifiedBytes: verify.len } : {}),
};

if (wantJson) console.log(JSON.stringify(result, null, 2));
else {
  console.log("url    : " + result.url);
  console.log("cookie : " + result.cookieHeader);
  if (verify) console.log("verify : HTTP " + verify.status + " (" + verify.len + " bytes)");
}
process.exit(verify && verify.status !== 200 ? 4 : 0);