// Which secret signed the detached helper's cookie?
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const cred = readFileSync("C:\\Users\\Mr.Wang\\.dsh\\.credentials.yaml", "utf8");
const stored = /client-connection\/browser-session[\s\S]*?secret:\s*(\S+)/.exec(cred)[1];
const b64url = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const dec = (s) => Buffer.from(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4), "base64");

const body = "eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxMjcuMC4wLjE6NjA4MzIiLCJpc3N1ZWRBdCI6MTc5MzAwODUxNDk2OSwiZXhwaXJlc0F0IjoxNzk1NjAwNTE0OTY5fQ";
const serverSig = "YYrqTtrLVvN8HldKhMODG038ZSbgGAsBc-2L__FHWIo";

const raw = dec(stored);
const sigRaw = b64url(createHmac("sha256", raw).update(body).digest());
const sigUtf8 = b64url(createHmac("sha256", stored).update(body).digest());

console.log(JSON.stringify({
  fileSecret: stored,
  fileSecretRawLen: raw.length,
  serverSig,
  sigFromFileSecretRaw: sigRaw,
  sigFromFileSecretUtf8: sigUtf8,
  MATCH_RAW: sigRaw === serverSig,
  MATCH_UTF8: sigUtf8 === serverSig,
  VERDICT: sigRaw === serverSig
    ? "detached helper uses the SAME secret — earlier 401 was NOT a secret mismatch"
    : "detached helper uses a DIFFERENT secret than $DSH_HOME/.credentials.yaml",
}, null, 2));