#!/usr/bin/env node
// Start a detached DSH Web helper and report a working cookie.
//
// Architecture note (learned the hard way):
//   - `dsh web` prints its REAL bound port inside the launch URL. Guessing the
//     port from --port can be wrong, and a helper that loses a port race serves
//     something that is not the DSH listener (observed: bare 404).
//   - Node's stdio pipe is a parent-child lifeline: a spawned child dies with
//     the parent unless detached with stdio:"ignore" — but then we lose the
//     stdout line carrying the real port.
//   - Solution: let the helper write its stdout to a FILE. The file survives
//     detachment and still records the launch URL.
//
// Usage:
//   node gui-helper.mjs            -> { port, url, pid }
//   node gui-helper.mjs --json
//   node gui-helper.mjs --stop
//
// Exit 0 ok, 3 helper never reported its URL.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync, writeFileSync, existsSync, unlinkSync, openSync } from "node:fs";
import http from "node:http";

const DIR = "C:\\Users\\Mr.Wang\\.dsh\\dsh-purge\\heal";
const LOG = DIR + "\\gui-helper.log";
const STATE = DIR + "\\gui-helper.json";
const NODE = "C:\\Users\\Mr.Wang\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe";
const BIN = "C:\\Users\\Mr.Wang\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
const URL_RE = /dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+))/;

const argv = new Set(process.argv.slice(2));
const wantJson = argv.has("--json");

if (argv.has("--stop")) {
  if (existsSync(STATE)) {
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    try { process.kill(st.pid); } catch {}
    try { unlinkSync(STATE); } catch {}
    console.log(JSON.stringify({ stopped: st.pid }));
  } else console.log(JSON.stringify({ stopped: null }));
  process.exit(0);
}

const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

const port = await freePort();
try { writeFileSync(LOG, ""); } catch {}
const fd = openSync(LOG, "w");

// Fully detached from the start: stdout/stderr -> file handles.
const child = spawn(NODE, [BIN, "web", "--port", String(port), "--no-open"], {
  stdio: ["ignore", fd, fd],
  detached: true,
  windowsHide: true,
});
child.unref();

// Poll the log file for the launch URL.
let match = null;
for (let i = 0; i < 160; i++) {
  await new Promise((r) => setTimeout(r, 500));
  let text = "";
  try { text = readFileSync(LOG, "utf8"); } catch { continue; }
  match = URL_RE.exec(text);
  if (match) break;
}

if (!match) {
  try { process.kill(child.pid); } catch {}
  process.stderr.write("gui-helper: no launch URL after 80s; log tail:\n" + (existsSync(LOG) ? readFileSync(LOG, "utf8").slice(-800) : "(no log)") + "\n");
  process.exit(3);
}

const realPort = Number(match[2]);
const url = match[1];

// Confirm it is really the DSH listener: a bare GET must answer 401.
const probe = await new Promise((resolve) => {
  const r = http.request({ host: "127.0.0.1", port: realPort, path: "/", method: "GET", timeout: 8000 }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
  r.on("error", () => resolve(0)); r.on("timeout", () => { r.destroy(); resolve(0); });
  r.end();
});

const state = { port: realPort, pid: child.pid, url, log: LOG, probeStatus: probe, startedAt: Date.now() };
writeFileSync(STATE, JSON.stringify(state, null, 2));

const out = { port: realPort, pid: child.pid, url, probeStatus: probe, launchUrl: url };
console.log(wantJson ? JSON.stringify(out, null, 2) : `http://127.0.0.1:${realPort}/`);
process.exit(probe === 401 ? 0 : 3);