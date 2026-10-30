// Single-process control experiment: start a helper, keep it ALIVE with the
// pipe attached (no detach dance), and test three cookies against it:
//   A) the cookie the server itself minted from the launch token
//   B) a cookie WE minted from the creds-file secret
//   C) no cookie
// All in one process lifetime, so authority/secret/PID are unambiguous.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";

const NODE = "C:\\Users\\Mr.Wang\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe";
const BIN = "C:\\Users\\Mr.Wang\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
const URL_RE = /dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+))/;

const b64url = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const cookieName = (a) => "dsh-auth-" + b64url(createHash("sha256").update(a).digest());
const secretKey = (s) => Buffer.from(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4), "base64");

const stored = /client-connection\/browser-session[\s\S]*?secret:\s*(\S+)/.exec(readFileSync("C:\\Users\\Mr.Wang\\.dsh\\.credentials.yaml", "utf8"))[1];

const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const get = (port, path, cookie) => new Promise((resolve) => {
  const r = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: cookie ? { Cookie: cookie } : {} }, (res) => {
    let n = 0; res.on("data", d => n += d.length);
    res.on("end", () => resolve({ status: res.statusCode, len: n, setCookie: res.headers["set-cookie"]?.[0] }));
  });
  r.on("error", e => resolve({ status: 0, err: e.message })); r.end();
});

const port = await freePort();
const child = spawn(NODE, [BIN, "web", "--port", String(port), "--no-open"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let out = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", d => out += d);
const m = await new Promise(res => { const t = setTimeout(() => res(null), 90000); const s = () => { const mm = URL_RE.exec(out); if (mm) { clearTimeout(t); res(mm); } }; child.stdout.on("data", s); s(); });
if (!m) { child.kill(); console.error("no url"); process.exit(3); }
const p = Number(m[2]), token = m[3];
await new Promise(r => setTimeout(r, 1500));  // let the listener settle

const C = await get(p, "/");
const A = await get(p, `/?token=${token}`);
const serverCookie = A.setCookie?.split(";")[0];
const Bverify = await get(p, "/", serverCookie);

const auth = `127.0.0.1:${p}`;
const now = Date.now(), exp = now + 30 * 86400000;
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: auth, issuedAt: now, expiresAt: exp }), "utf8"));
const sig = b64url(createHmac("sha256", secretKey(stored)).update(body).digest());
const forged = `${cookieName(auth)}=v1.${body}.${sig}`;
const Cverify = await get(p, "/", forged);

child.kill();
console.log(JSON.stringify({
  port: p,
  A_noCookie: { status: C.status },
  B_exchange: { status: A.status, mintedName: serverCookie?.split("=")[0] },
  C_withServerCookie: { status: Bverify.status, len: Bverify.len },
  D_withForgedCookie: { status: Cverify.status, len: Cverify.len, name: forged.split("=")[0] },
  namesIdentical: forged.split("=")[0] === serverCookie?.split("=")[0],
  VERDICT: Cverify.status === 200 ? "FORGERY OK in-process" : "forgery rejected in-process",
}, null, 2));