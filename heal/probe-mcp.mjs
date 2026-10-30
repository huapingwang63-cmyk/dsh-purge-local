// MCP stdio probe: start @playwright/mcp, handshake, list tools, then exit.
import { spawn } from "node:child_process";

const NODE = "C:\\Users\\Mr.Wang\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe";
const CLI = "C:\\Users\\Mr.Wang\\AppData\\Roaming\\npm\\node_modules\\@playwright\\mcp\\cli.js";

const args = (process.argv[2] || "chrome").split(",");
const child = spawn(NODE, [CLI, "--browser", args[0], "--headless", "--isolated", "--caps", "vision,pdf,devtools"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
});

let buf = "";
let phase = "init";
const seen = [];

child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { console.log("[raw]", line.slice(0, 200)); continue; }
    if (msg.id === 1) {
      const info = msg.result?.serverInfo;
      console.log("[initialize ok]", JSON.stringify(info), "protocol", msg.result?.protocolVersion);
      phase = "initialized";
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    } else if (msg.id === 2) {
      const tools = msg.result?.tools || [];
      console.log("[tools]", tools.length);
      for (const t of tools) console.log("   ", t.name, "—", String(t.description || "").slice(0, 60).replace(/\s+/g, " "));
      console.log("[probe] OK");
      child.kill();
      process.exit(0);
    } else if (msg.error) {
      console.log("[rpc error]", JSON.stringify(msg.error).slice(0, 300));
    }
  }
});

child.stderr.on("data", (d) => {
  const s = d.toString().trim();
  if (s) console.log("[stderr]", s.slice(0, 300));
});

child.on("error", (e) => { console.log("[spawn error]", e.message); process.exit(1); });
child.on("exit", (c) => { if (phase !== "done") console.log("[exit]", c); });

child.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
}) + "\n");

setTimeout(() => { console.log("[timeout] killing"); child.kill(); process.exit(1); }, 45000);
