// Recover / verify the browser-auth HMAC key by testing candidate secrets
// against a cookie the host itself minted (captured from the Playwright jar).
//
// If a candidate reproduces the observed signature, that candidate IS the
// server's signing secret and cookie forgery is proven — no live 401 needed.
import { createHmac, createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const OBSERVED_NAME = "dsh-auth-BkVgr-42Ur14shA3Cd6p4mFwDdFtwHs_6BuiY7RZBE0";
const OBSERVED_VALUE = process.argv[2]; // full cookie value v1.body.sig
const AUTHORITY = process.argv[3] ?? "127.0.0.1:50510";

if (!OBSERVED_VALUE) { console.error("usage: node verify-secret.mjs <cookieValue> [authority]"); process.exit(1); }

const parts = OBSERVED_VALUE.split(".");
const [, body, sig] = parts;

const b64url = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const cookieName = (a) => "dsh-auth-" + b64url(createHash("sha256").update(a).digest());

const candidates = [];

// 1) every "secret:"-looking value in the credentials file
const cred = readFileSync("C:\\Users\\Mr.Wang\\.dsh\\.credentials.yaml", "utf8");
for (const m of cred.matchAll(/secret:\s*(\S+)/g)) candidates.push(["creds-file", m[1]]);
for (const m of cred.matchAll(/(sk-[A-Za-z0-9._-]+)/g)) candidates.push(["creds-file-key", m[1]]);

// 2) env
for (const [k, v] of Object.entries(process.env)) if (v && v.length >= 20) candidates.push(["env:" + k, v]);

// 3) name-hash sanity
const nameCheck = cookieName(AUTHORITY) === OBSERVED_NAME;

const hits = [];
for (const [tag, cand] of candidates) {
  for (const form of [cand, Buffer.from(cand, "base64").toString("binary")]) {
    const sigTry = b64url(createHmac("sha256", form).update(body).digest());
    if (sigTry === sig) hits.push({ tag, secretLen: cand.length, form: form === cand ? "utf8" : "b64-decoded" });
  }
}

console.log(JSON.stringify({
  authority: AUTHORITY,
  nameMatchesSha256OfAuthority: nameCheck,
  observedSigLen: sig.length,
  candidatesTried: candidates.length,
  HITS: hits,
}, null, 2));