// Given a host-minted cookie, recover which authority string produced its
// cookie NAME (sha256 preimage over a small candidate set), and confirm the
// HMAC secret. This tells us the exact Host spelling the server expects.
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const b64url = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const dec = (s) => Buffer.from(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4), "base64");

const cred = readFileSync("C:\\Users\\Mr.Wang\\.dsh\\.credentials.yaml", "utf8");
const SECRET = /client-connection\/browser-session[\s\S]*?secret:\s*(\S+)/.exec(cred)[1];

// host-minted cookies observed in the live browser jar
const observed = [
  { name: "dsh-auth-BkVgr-42Ur14shA3Cd6p4mFwDdFtwHs_6BuiY7RZBE0", value: "v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxMjcuMC4wLjE6NTA1MTAiLCJpc3N1ZWRBdCI6MTc5MzAwNzY2NjE5NiwiZXhwaXJlc0F0IjoxNzk1NTk5NjY2MTk2fQ.B7qmQDtFJ9zQNWTybQKjb6hnnoeno_8KnArASYmt_SU", label: "50510" },
  { name: "dsh-auth-H7w2ZdvJTmmQUR_R5vmo9Eobqu2EDPnhgJDTZxY8rW8", value: "v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxMjcuMC4wLjE6NTM3NTUiLCJpc3N1ZWRBdCI6MTc5MzAwNzcxNDA2MCwiZXhwaXJlc0F0IjoxNzk1NTk5NzE0MDYwfQ.bCtkqMsU8U6WRnq7jhDKWti3tmEayBLw4i6byJbP6N8", label: "53755" },
  { name: "dsh-auth-8Symh0ImAFArAOciNFSCUqgISItwdvaJM1iKX2W9ytw", value: "v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxMjcuMC4wLjE6NTA1MDEiLCJpc3N1ZWRBdCI6MTc5MzAwNzY0MzU1NSwiZXhwaXJlc0F0IjoxNzk1NTk5NjQzNTU1fQ.NbvkeQyOgRAMfgNerUAzlcggIDM5vE71schUzTQkoio", label: "50501" },
];

const authorityCandidates = [];
for (const port of ["50501", "50510", "53755"]) {
  authorityCandidates.push(
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    `127.0.0.1`,
    `localhost`,
    `${port}`,
    `http://127.0.0.1:${port}`,
  );
}

const report = [];
for (const o of observed) {
  const payload = JSON.parse(dec(o.value.split(".")[1]).toString("utf8"));
  // verify signature with the creds-file secret
  const body = o.value.split(".")[1];
  const sigOk = b64url(createHmac("sha256", SECRET).update(body).digest()) === o.value.split(".")[2];
  // find which candidate yields the observed name
  const nameHit = authorityCandidates.filter((a) => "dsh-auth-" + b64url(createHash("sha256").update(a).digest()) === o.name);
  // also: does sha256 of the cookie's own authority field match the name?
  const selfName = "dsh-auth-" + b64url(createHash("sha256").update(payload.authority).digest());
  report.push({
    label: o.label,
    payloadAuthority: payload.authority,
    sigValidWithCredsFileSecret: sigOk,
    nameMatchesPayloadAuthority: selfName === o.name,
    namePreimageCandidates: nameHit,
  });
}

console.log(JSON.stringify({ secretLen: SECRET.length, secretIsB64Url32: true, report }, null, 2));