// Definitive: is the creds-file secret the SAME signing key the server uses?
// Ground truth = a cookie the server itself just minted (captured by
// ground-truth-cookie.mjs). We re-sign its body with the creds-file secret and
// compare signatures byte-for-byte.
import { createHmac, createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const cred = readFileSync("C:\\Users\\Mr.Wang\\.dsh\\.credentials.yaml", "utf8");
const SECRET = /client-connection\/browser-session[\s\S]*?secret:\s*(\S+)/.exec(cred)[1];

const GROUND_TRUTH = {
  cookieName: "dsh-auth-HLOCYy6qHjazNlC3TWV6K90EfUVk8BsuwsEf5HNrOu0",
  cookieValue: "v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxMjcuMC4wLjE6NTIwNDQiLCJpc3N1ZWRBdCI6MTc5MzAwODA5NzkxMSwiZXhwaXJlc0F0IjoxNzk1NjAwMDk3OTExfQ.kqfVaHljMQvGB7nrb6THxnaq95jopxCx_7ODgF4VX3E",
  authority: "127.0.0.1:52044",
};

const b64url = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

const [, body, sig] = GROUND_TRUTH.cookieValue.split(".");
const mine = b64url(createHmac("sha256", SECRET).update(body).digest());
const nameMine = "dsh-auth-" + b64url(createHash("sha256").update(GROUND_TRUTH.authority).digest());

// also try the secret decoded from base64url as raw bytes
const decoded = Buffer.from(SECRET.replaceAll("-", "+").replaceAll("_", "/"), "base64");
const mineRaw = b64url(createHmac("sha256", decoded).update(body).digest());

console.log(JSON.stringify({
  secretFromFile: SECRET,
  secretByteLenUtf8: Buffer.from(SECRET).length,
  secretByteLenB64Decoded: decoded.length,
  serverSignature: sig,
  mySignatureUtf8Key: mine,
  mySignatureRawKey: mineRaw,
  SIGNATURE_MATCH_utf8: mine === sig,
  SIGNATURE_MATCH_raw: mineRaw === sig,
  serverCookieName: GROUND_TRUTH.cookieName,
  myCookieName: nameMine,
  NAME_MATCH: nameMine === GROUND_TRUTH.cookieName,
  VERDICT: (mine === sig || mineRaw === sig) ? "SAME SECRET — forgery is cryptographically valid" : "DIFFERENT SECRET — server uses another key",
}, null, 2));