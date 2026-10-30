// End-to-end proof on a helper WE control:
//   1. start `dsh web` on a free port
//   2. GET /?token=<launch> -> capture 303 + Set-Cookie (server-minted, ground truth)
//   3. GET / with that exact cookie -> must be 200 (proves the cookie path works)
//   4. GET / with a cookie WE minted from the creds-file secret -> compare
// If (4) also returns 200, forgery works and the host must differ some other way.
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
const secretKey = (stored) => Buffer.from(stored.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((stored.length + 3) % 4), "base64");

const stored = /client-connection\/browser-session[\s\S]*?secret:\s*(\S+)/.exec(readFileSync("C:\\Users\\Mr.Wang\\.dsh\\.credentials.yaml", "utf8"))[1];
const KEY = secretKey(stored);

function freePort() {
  return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const get = (port, path, cookie) => new Promise((resolve) => {
  const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: cookie ? { Cookie: cookie } : {} }, (r) => {
    let body = ""; r.setEncoding("utf8"); r.on("data", d => body += d);
    r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, bodyLen: body.length, bodyHead: body.slice(0, 80) }));
  });
  req.on("error", e => resolve({ error: e.message })); req.end();
});

const port = await freePort();
const child = spawn(NODE, [BIN, "web", "--port", String(port), "--no-open"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let out = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", d => out += d);
const m = await new Promise(res => { const t = setTimeout(() => res(null), 60000); const s = () => { const mm = URL_RE.exec(out); if (mm) { clearTimeout(t); res(mm); } }; child.stdout.on("data", s); s(); });
if (!m) { child.kill(); console.error("no URL"); process.exit(3); }
const p = Number(m[2]), token = m[3];

const baseline = await get(p, "/");                    // no cookie -> 401
const exchange = await get(p, `/?token=${token}`);      // mint
const sc = exchange.headers["set-cookie"]?.[0] ?? "";
const serverCookie = sc.split(";")[0];
const withServerCookie = await get(p, "/", serverCookie); // should be 200

// now MY forged cookie for this same authority
const auth = `127.0.0.1:${p}`;
const issuedAt = Date.now(), expiresAt = issuedAt + 30 * 86400000;
const bodyB64 = b64url(Buffer.from(JSON.stringify({ version: 1, authority: auth, issuedAt, expiresAt }), "utf8"));
const sig = b64url(createHmac("sha256", KEY).update(bodyB64).digest());
const forged = `${cookieName(auth)}=v1.${bodyB64}.${sig}`;
const withForged = await get(p, "/", forged);

child.kill();
console.log(JSON.stringify({
  helperPort: p,
  noCookie: { status: baseline.status },
  exchange: { status: exchange.status, setCookie: sc },
  serverMintedCookie: { name: serverCookie.split("=")[0], status: withServerCookie.status, bodyLen: withServerCookie.bodyLen },
  forgedCookie: { name: forged.split("=")[0], status: withForged.status, bodyLen: withForged.bodyLen },
  nameMatch: forged.split("=")[0] === serverCookie.split("=")[0],
  VERDICT: withForged.status === 200 ? "FORGERY WORKS end-to-end" : (withServerCookie.status === 200 ? "server cookie works but forgery fails" : "cookie path itself broken"),
}, null, 2));