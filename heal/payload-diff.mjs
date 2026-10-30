// Byte-compare the detached helper's server-minted cookie payload against an
// offline-minted one. Secret is identical (proven by check-detach-secret.mjs),
// so any 401 must come from a payload difference.
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";

const PORT = 60832;
const TOKEN = "A0H9xQGaqaoA7p_9unsIh-DmvP0HnVK1_dqPpwGP55U";
const b64url = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const dec = (s) => Buffer.from(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4), "base64");

const stored = /client-connection\/browser-session[\s\S]*?secret:\s*(\S+)/.exec(readFileSync("C:\\Users\\Mr.Wang\\.dsh\\.credentials.yaml", "utf8"))[1];
const key = dec(stored);
const auth = `127.0.0.1:${PORT}`;
const name = "dsh-auth-" + b64url(createHash("sha256").update(auth).digest());

const get = (path, cookie) => new Promise((resolve) => {
  const r = http.request({ host: "127.0.0.1", port: PORT, path, method: "GET", headers: cookie ? { Cookie: cookie } : {} }, (res) => {
    let n = 0; res.on("data", d => n += d.length);
    res.on("end", () => resolve({ status: res.statusCode, len: n, setCookie: res.headers["set-cookie"]?.[0] }));
  });
  r.on("error", e => resolve({ status: 0, err: e.message })); r.end();
});

// 1) server-minted
const ex = await get(`/?token=${TOKEN}`);
const serverPair = ex.setCookie.split(";")[0];
const serverBody = serverPair.split("=")[1].split(".")[1];
const serverSig = serverPair.split(".")[2];
const serverPayload = JSON.parse(Buffer.from(serverBody.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8"));

// 2) offline-minted, replicating the server field-for-field
const now = Date.now();
const exp = now + 30 * 86400000;
const minePayload = { version: 1, authority: auth, issuedAt: now, expiresAt: exp };
const mineBody = b64url(Buffer.from(JSON.stringify(minePayload), "utf8"));
const mineSig = b64url(createHmac("sha256", key).update(mineBody).digest());
const minePair = `${name}=v1.${mineBody}.${mineSig}`;

// 3) offline-minted with an authority of "localhost" instead of the IP literal
const altAuth = `localhost:${PORT}`;
const altName = "dsh-auth-" + b64url(createHash("sha256").update(altAuth).digest());
const altPayload = { version: 1, authority: altAuth, issuedAt: now, expiresAt: exp };
const altBody = b64url(Buffer.from(JSON.stringify(altPayload), "utf8"));
const altSig = b64url(createHmac("sha256", key).update(altBody).digest());
const altPair = `${altName}=v1.${altBody}.${altSig}`;

const rServer = await get("/", serverPair);
const rPlain = await get("/", `${name}=v1.${mineBody}.${mineSig}`);
const rMineNamed = await get("/", minePair);
const rAlt = await get("/", altPair);

// 4) replay the server pair verbatim
const rReplay = await get("/", serverPair);

console.log(JSON.stringify({
  auth,
  name,
  serverPayload,
  myPayload: minePayload,
  payloadFieldDiff: {
    version: serverPayload.version === minePayload.version,
    authority: serverPayload.authority === minePayload.authority,
    issuedAtIsNumber: typeof serverPayload.issuedAt === "number",
    expiresAtIsNumber: typeof serverPayload.expiresAt === "number",
    lifetimeDays: (serverPayload.expiresAt - serverPayload.issuedAt) / 86400000,
  },
  serverSig,
  results: {
    A_serverPair_replay: { status: rServer.status, len: rServer.len },
    B_serverPair_replay_again: { status: rReplay.status, len: rReplay.len },
    C_offline_mine_inline: { status: rPlain.status },
    D_offline_mine_named: { status: rMineNamed.status },
    E_offline_mine_named_again: { status: rMineNamed.status, len: rMineNamed.len },
    F_offline_localhost_authority: { status: rAlt.status },
  },
  names: {
    ipName: name,
    serverName: serverPair.split("=")[0],
    ipNameMatchesServer: name === serverPair.split("=")[0],
    localhostName: altName,
  },
}, null, 2));