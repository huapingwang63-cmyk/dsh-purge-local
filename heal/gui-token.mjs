#!/usr/bin/env node
// GUI token harvester.
//
// The desktop host mints its browser-auth launch token inside the Electron
// process (randomBytes at runtime, never persisted), so it cannot be read from
// disk. Instead we boot a short-lived `dsh web` on a free loopback port; it
// prints `dsh web: http://127.0.0.1:PORT/?token=...` on stdout, which gives us
// the live token. The helper is killed when harvesting finishes.
//
// Usage:
//   node gui-token.mjs            -> prints the token (30 min cache honoured)
//   node gui-token.mjs --refresh  -> ignore cache, harvest again
//   node gui-token.mjs --url      -> print the full authenticated URL
//   node gui-token.mjs --json     -> { token, url, port, harvestedAt, cached }
//   node gui-token.mjs --keep     -> leave the helper running (default: kill)
//
// Exit 0 on success, 3 when the helper never printed a URL.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";

const NODE = "C:\\Users\\Mr.Wang\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe";
const BIN = "C:\\Users\\Mr.Wang\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
const HEAL = "C:\\Users\\Mr.Wang\\.dsh\\dsh-purge\\heal";
const CACHE = HEAL + "\\gui-token.json";
const TTL_MS = 30 * 60 * 1000;
const URL_RE = /dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+))/;

const argv = new Set(process.argv.slice(2));
const wantUrl = argv.has("--url");
const wantJson = argv.has("--json");
const refresh = argv.has("--refresh");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function readCache() {
  try {
    const raw = JSON.parse(readFileSync(CACHE, "utf8"));
    if (!raw?.token || !raw?.port) return null;
    if (Date.now() - raw.harvestedAt > TTL_MS) return null;
    return raw;
  } catch {
    return null;
  }
}

function emit(rec) {
  if (wantJson) return JSON.stringify(rec, null, 2);
  if (wantUrl) return rec.url;
  return rec.token;
}

async function harvest() {
  const port = await freePort();
  const child = spawn(NODE, [BIN, "web", "--port", String(port), "--no-open"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DSH_WEB_NO_OPEN: "1" },
    windowsHide: true,
  });

  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });

  const match = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 60000);
    const scan = () => {
      const m = URL_RE.exec(out);
      if (m) { clearTimeout(timer); resolve(m); }
    };
    child.stdout.on("data", scan);
    child.once("exit", () => { clearTimeout(timer); resolve(null); });
    scan();
  });

  if (!match) {
    child.kill();
    process.stderr.write("gui-token: helper never printed a URL\n");
    if (err.trim()) process.stderr.write(err.trim().split("\n").slice(-8).join("\n") + "\n");
    process.exit(3);
  }

  // stdio pipes are the parent<->helper lifeline: when this process exits, the
  // helper must survive. Detach it and give it null stdio so nothing closes.
  child.stdio.forEach((s) => s?.destroy?.());
  child.unref();
  if (argv.has("--keep")) {
    child.kill(); // first helper was bound to our pipes; re-spawn detached below
  } else {
    child.kill();
    await new Promise((r) => { child.once("exit", r); setTimeout(r, 3000); });
  }

  let helperPid = null;
  if (argv.has("--keep")) {
    // Detached second helper: it owns the port and outlives this process.
    const keep = spawn(NODE, [BIN, "web", "--port", String(match[2]), "--no-open"], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      env: { ...process.env, DSH_WEB_NO_OPEN: "1" },
    });
    keep.unref();
    helperPid = keep.pid ?? null;
    // wait for the listener to come back up
    const deadline = Date.now() + 45000;
    const up = await new Promise((resolve) => {
      const tick = () => {
        const probe = fetch(`http://127.0.0.1:${match[2]}/api/health`).then(() => resolve(true)).catch(() => {
          if (Date.now() > deadline) resolve(false); else setTimeout(tick, 400);
        });
        return probe;
      };
      tick();
    });
    if (!up) process.stderr.write("gui-token: detached helper did not come up on port " + match[2] + "\n");
  }

  const rec = {
    token: match[3],
    port: Number(match[2]),
    url: match[1],
    harvestedAt: Date.now(),
    harvestedAtIso: new Date().toISOString(),
    helperKept: argv.has("--keep"),
    helperPid,
  };
  writeFileSync(CACHE, JSON.stringify(rec, null, 2), "utf8");
  return rec;
}

const cached = refresh ? null : readCache();
if (cached) {
  console.log(emit({ ...cached, cached: true }));
  process.exit(0);
}
const rec = await harvest();
console.log(emit({ ...rec, cached: false }));
