// Ground truth collector: start a `dsh web` helper, drive its own launch-token
// URL through a real HTTP client, capture the 303 + Set-Cookie the helper
// mints, and report that cookie's exact bytes and signature.
//
// This is the ONLY way to obtain a server-minted cookie as ground truth:
// the helper's launch token is known to us, so the exchange is guaranteed.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";

const NODE = "C:\\Users\\Mr.Wang\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe";
const BIN = "C:\\Users\\Mr.Wang\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
const URL_RE = /dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+))/;

const b64url = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const sha256name = (a) => "dsh-auth-" + b64url(createHash("sha256").update(a).digest());

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

const port = await freePort();
const child = spawn(NODE, [BIN, "web", "--port", String(port), "--no-open"], {
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
let out = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => { out += d; });

const m = await new Promise((res) => {
  const t = setTimeout(() => res(null), 60000);
  const scan = () => { const mm = URL_RE.exec(out); if (mm) { clearTimeout(t); res(mm); } };
  child.stdout.on("data", scan); scan();
});
if (!m) { child.kill(); console.error("helper never printed URL"); process.exit(3); }

const [full, base, p, token] = m;
console.log(JSON.stringify({ phase: "harvested", port: p, token }, null, 2));

// Exchange: raw http request so we see the 303 + Set-Cookie verbatim.
const http = await import("node:http");
const exchange = await new Promise((resolve) => {
  const req = http.request({ host: "127.0.0.1", port: Number(p), path: `/?token=${token}`, method: "GET" }, (r) => {
    resolve({ status: r.statusCode, headers: r.headers });
  });
  req.on("error", (e) => resolve({ error: e.message }));
  req.end();
});

let parsed = null;
if (exchange.headers?.["set-cookie"]) {
  const sc = exchange.headers["set-cookie"][0];
  const kv = sc.split(";")[0];
  const eq = kv.indexOf("=");
  const cname = kv.slice(0, eq), cval = kv.slice(eq + 1);
  const parts = cval.split(".");
  let payload = null;
  try { payload = JSON.parse(Buffer.from(parts[1].replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8")); } catch {}
  parsed = {
    cookieName: cname,
    cookieValue: cval,
    version: parts[0],
    bodyB64: parts[1],
    sigB64: parts[2],
    payload,
    nameExpectedFromPayloadAuthority: sha256name(payload?.authority ?? "?"),
    nameMatches: cname === sha256name(payload?.authority ?? "?"),
    attributes: sc.split(";").slice(1).map(s => s.trim()),
  };
}

child.kill();
console.log(JSON.stringify({ phase: "exchange", helperPort: Number(p), status: exchange.status, exchangeHeaders: exchange.headers, groundTruthCookie: parsed }, null, 2));