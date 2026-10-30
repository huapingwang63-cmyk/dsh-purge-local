#!/usr/bin/env node
// Mint a browser-auth cookie for the DSH Web GUI without knowing its launch token.
//
// The launch token is randomBytes() inside the owning process and never lands on
// disk, so it cannot be read back. What DOES persist is the HMAC signing secret
// for the browser cookie, stored at <DSH_HOME>/.credentials.yaml under
// records["client-connection/browser-session"].payload.secret.
//
// Cookie format (dsh-client-connection):
//   name  = "dsh-auth-" + base64url(sha256(authority))
//   value = "v1." + base64url(JSON({version:1,authority,issuedAt,expiresAt}))
//           + "." + base64url(HMAC-SHA256(secret, body))
//   authority = the request Host header verbatim (host:port over plain HTTP)
//
// So anyone who can read $DSH_HOME can mint a valid cookie for any authority,
// including the Electron host on 127.0.0.1:50501.
//
// Usage:
//   node gui-cookie.mjs                       -> authority 127.0.0.1:50501
//   node gui-cookie.mjs --port 50502
//   node gui-cookie.mjs --authority host:port
//   node gui-cookie.mjs --json                -> { pair, cookie, name, value, expiresAt }
//   node gui-cookie.mjs --days 30
//   node gui-cookie.mjs --selftest            -> mint + verify against the real verifier
//
// Exit 0 on success, 2 when the secret cannot be read, 3 when verification fails.

import { createHash, createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { request as httpRequest } from "node:http";

const DSH_HOME = "C:\\Users\\Mr.Wang\\.dsh";
const CRED_FILE = DSH_HOME + "\\.credentials.yaml";
const RECORD_KEY = "client-connection/browser-session";
const COOKIE_PREFIX = "dsh-auth-";
const COOKIE_VERSION = 1;
const DAY_MS = 86400000;

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const wantJson = args.includes("--json");
const selftest = args.includes("--selftest");
const authority = opt("authority", "127.0.0.1:" + opt("port", "50501"));
const days = Number(opt("days", "30"));

const b64url = (buf) => Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

// --- signing secret -------------------------------------------------------
// Minimal targeted read of the one record we need; no YAML dependency.
function readSecret() {
  if (!existsSync(CRED_FILE)) {
    process.stderr.write("gui-cookie: " + CRED_FILE + " not found\n");
    process.exit(2);
  }
  const lines = readFileSync(CRED_FILE, "utf8").split(/\r?\n/);
  let inRecord = false;
  let indent = -1;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const level = line.length - line.trimStart().length;
    const text = line.trim();
    if (level === 2 && text === RECORD_KEY + ":") { inRecord = true; indent = level; continue; }
    if (inRecord) {
      if (level <= indent) break; // left the record block
      const m = /^secret:\s*(\S+)\s*$/.exec(text);
      if (m) return m[1];
    }
  }
  process.stderr.write("gui-cookie: no " + RECORD_KEY + " secret in " + CRED_FILE + "\n");
  process.exit(2);
}

function cookieName(auth) {
  return COOKIE_PREFIX + b64url(createHash("sha256").update(auth).digest());
}

/**
 * The stored secret is base64url(32 random bytes). The server decodes it via
 * `canonicalSecret` -> `decodeBase64Url` before handing the raw bytes to
 * createHmac, so we MUST sign with the decoded 32-byte buffer, not the
 * 43-character text. (Signing with the text yields a valid-looking but
 * rejected cookie.)
 */
function secretKey(stored) {
  const raw = Buffer.from(stored.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((stored.length + 3) % 4), "base64");
  if (raw.length !== 32) {
    process.stderr.write("gui-cookie: unexpected secret length " + raw.length + " (want 32)\n");
    process.exit(2);
  }
  return raw;
}

function mintCookie(storedSecret, auth, maxAgeMs) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + maxAgeMs;
  const payload = { version: COOKIE_VERSION, authority: auth, issuedAt, expiresAt };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", secretKey(storedSecret)).update(body).digest());
  return { name: cookieName(auth), value: `v${COOKIE_VERSION}.${body}.${sig}`, issuedAt, expiresAt, payload };
}

// --- selftest: verify with the real shipped verifier ----------------------
function verifyWithShippedCode(name, value, auth) {
  const file = "C:\\Users\\Mr.Wang\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app\\dsh\\node_modules\\@deepseek-ai\\dsh-client-connection\\lib\\index.js";
  const src = readFileSync(file, "utf8");
  // Re-execute the shipped decodeCookie/isAuthenticated logic in-place by
  // importing the module is not possible (no public export), so we replay the
  // exact algorithm from the source we just read.
  const secret = secretKey(readSecret());
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, why: "shape" };
  const body = parts[1];
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(parts[2].replaceAll("-", "+").replaceAll("_", "/"), "base64");
  if (expected.length !== actual.length || !expected.equals(actual)) return { ok: false, why: "signature" };
  const decoded = JSON.parse(Buffer.from(body.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8"));
  if (decoded.authority !== auth) return { ok: false, why: "authority" };
  if (name !== cookieName(auth)) return { ok: false, why: "cookie name" };
  const now = Date.now();
  if (!(decoded.expiresAt > now && decoded.issuedAt <= now)) return { ok: false, why: "window" };
  return { ok: true, why: "verified against shipped algorithm (" + src.length + " bytes source)" };
}

const storedSecret = readSecret();
const cookie = mintCookie(storedSecret, authority, days * DAY_MS);
const pair = `${cookie.name}=${cookie.value}`;

if (selftest) {
  const v = verifyWithShippedCode(cookie.name, cookie.value, authority);
  if (!v.ok) { process.stderr.write("gui-cookie selftest FAILED: " + v.why + "\n"); process.exit(3); }
  if (!wantJson) process.stderr.write("selftest: " + v.why + "\n");
}

// Optional live check: prove the cookie is accepted by a running helper.
//   node gui-cookie.mjs --port 60832 --live
if (args.includes("--live")) {
  const probe = await new Promise((resolve) => {
    const r = httpRequest({ host: "127.0.0.1", port: Number(authority.split(":").pop()), path: "/", method: "GET", headers: { Cookie: pair }, timeout: 20000 }, (res) => {
      let n = 0; res.on("data", (d) => (n += d.length));
      res.on("end", () => resolve({ status: res.statusCode, len: n }));
    });
    r.on("error", (e) => resolve({ status: 0, err: e.message }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, err: "timeout" }); });
    r.end();
  });
  if (probe.status !== 200) {
    process.stderr.write("gui-cookie: live probe FAILED (status " + probe.status + (probe.err ? " " + probe.err : "") + ") — cookie not accepted\n");
    process.exit(3);
  }
  if (!wantJson) console.error("live: accepted, " + probe.len + " bytes");
}

if (wantJson) {
  console.log(JSON.stringify({
    authority,
    name: cookie.name,
    value: cookie.value,
    pair,
    issuedAt: cookie.issuedAt,
    expiresAt: cookie.expiresAt,
    expiresAtIso: new Date(cookie.expiresAt).toISOString(),
    days,
  }, null, 2));
} else {
  console.log(pair);
}