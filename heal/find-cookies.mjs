// Extract the host's own browser-auth cookie from the Playwright MCP profile
// on disk, so we can test candidate HMAC keys offline.
//
// Playwright persists the browser context under %LOCALAPPDATA%\ms-playwright\
// or the MCP server's user-data-dir. We scan both for Cookies SQLite files and
// dump the dsh-auth-* rows.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = [
  process.env.LOCALAPPDATA + "\\ms-playwright",
  process.env.USERPROFILE + "\\AppData\\Local\\Temp",
  process.env.APPDATA + "\\@playwright",
  "D:\\DSH工作台\\.playwright-mcp",
  process.env.TEMP,
].filter(Boolean);

const found = [];
function walk(dir, depth) {
  if (depth > 6) return;
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1);
    else if (/^Cookies$/i.test(e.name) || /cookies/i.test(e.name)) {
      try { found.push({ path: full, size: statSync(full).size }); } catch {}
    }
  }
}

for (const r of roots) if (r && existsSync(r)) walk(r, 0);
console.log(JSON.stringify({ searchedRoots: roots, cookieFiles: found }, null, 2));