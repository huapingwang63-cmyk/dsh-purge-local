// dsh-purge heal: rebuild the unpacked host from app.asar and re-apply all patches.
// Must run while the DeepSeek Harness desktop host is NOT running.
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PLUGIN = "C:/Users/Mr.Wang/.dsh/profiles/desktop/node_modules/dsh-purge-community";
const CORE = pathToFileURL(path.join(PLUGIN, "lib", "core.js")).href;
const EXTRACT = pathToFileURL(path.join(PLUGIN, "lib", "extract-asar.js")).href;
const RES = "C:/Users/Mr.Wang/AppData/Local/Programs/DeepSeek Harness/resources";
const FALLBACK_ASAR = path.join(RES, "app.asar");

process.env.DSH_HOME = process.env.DSH_HOME || "C:/Users/Mr.Wang/.dsh";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const emit = (o) => console.log(JSON.stringify(o, null, 2));
const log = (...a) => console.error("[heal]", ...a);
const die = (stage, error) => { emit({ ok: false, stage, error: String(error?.message || error) }); process.exit(1); };

const core = await import(CORE).catch((e) => die("import-core", e));
const ea = await import(EXTRACT).catch((e) => die("import-extract", e));

// ---------- 1. locate install ----------
let handoff = null;
try { handoff = core.sealedAsarHandoff({ surface: "desktop", discover: true }); } catch (e) { log("handoff:", e.message); }
const exe = handoff?.exe || "C:/Users/Mr.Wang/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe";
const asarPath = handoff?.asar || FALLBACK_ASAR;
const appDir = path.join(path.dirname(asarPath), "app");
const aiBase = path.join(appDir, "dsh", "node_modules", "@deepseek-ai");

const state = {
  exe,
  asar: asarPath,
  appDir,
  asarExists: fs.existsSync(asarPath),
  appExists: fs.existsSync(appDir),
  aiBaseExists: fs.existsSync(aiBase),
};
log("state", JSON.stringify(state));

// ---------- 2. host must be idle ----------
const hostRunning = () => {
  try {
    const raw = execFileSync("tasklist", ["/FI", "IMAGENAME eq DeepSeek Harness.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
    return /"DeepSeek Harness\.exe"/i.test(raw);
  } catch { return false; }
};
const running = hostRunning();
if (checkOnly) { emit({ ok: true, mode: "check", hostRunning: running, ...state }); process.exit(0); }
if (running) {
  emit({ ok: false, stage: "preflight", error: "host-running", hint: "quit DeepSeek Harness completely, then rerun", ...state });
  process.exit(2);
}

// ---------- 3. rebuild unpacked tree when an archive is present ----------
let rebuilt = false;
let prevDir = "";
if (state.asarExists) {
  try {
    log("extracting", asarPath);
    const side = ea.extractAsarToSide(asarPath, appDir);
    log("extracted files", side.count);
    ea.overlayAsarUnpacked(asarPath, side.next);
    const committed = ea.commitExtractedDir(appDir, side.next);
    prevDir = committed.prev || "";
    rebuilt = true;
    log("committed; prev =", prevDir);
  } catch (e) { die("extract", e); }
}

if (!fs.existsSync(path.join(appDir, "package.json"))) die("verify", "resources/app/package.json missing");
if (!fs.existsSync(aiBase)) die("verify", "@deepseek-ai missing under resources/app");

// ---------- 4. host patches ----------
let report = [];
try {
  core.refreshHooksDenySettings();
  report = await core.applyPatches(aiBase, core.ALL_PATCHES, { preserveClientBundles: false, forApply: true });
} catch (e) { die("patch", e); }
const tally = {};
for (const r of report) tally[r.status] = (tally[r.status] || 0) + 1;
log("patch tally", JSON.stringify(tally));

// ---------- 5. pi-ai developer-role allowlist, every copy ----------
const WL = '(String(model.baseUrl || "").toLowerCase().includes("api.openai.com") || String(model.baseUrl || "").toLowerCase().includes("azure.com"))';
const PI = {
  "openai-completions.js": [
    ['const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";',
      `const instructionRole = model.reasoning && compat.supportsDeveloperRole && ${WL} ? "developer" : "system"; // [dsh-purge] developer role allowlist: openai/azure`],
  ],
  "openai-responses-shared.js": [
    ['const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";',
      `const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false && ${WL} ? "developer" : "system"; // [dsh-purge] developer role allowlist: openai/azure`],
  ],
};
const piFixed = [];
const walk = (dir, depth) => {
  if (depth > 9) return;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p, depth + 1); continue; }
    if (!PI[e.name] || !dir.endsWith(path.join("pi-ai", "dist", "api"))) continue;
    let text; try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
    if (text.includes("[dsh-purge] developer role allowlist")) continue;
    let changed = false;
    for (const [pat, rep] of PI[e.name]) {
      if (text.split(pat).length - 1 !== 1) continue;
      if (!fs.existsSync(p + ".purge-bak")) { try { fs.copyFileSync(p, p + ".purge-bak"); } catch {} }
      text = text.replace(pat, rep);
      changed = true;
    }
    if (changed) { try { fs.writeFileSync(p, text, "utf8"); piFixed.push(p); } catch {} }
  }
};
walk(path.dirname(appDir), 0);
walk("C:/Users/Mr.Wang/.dsh/profiles", 0);
log("pi-ai fixed", piFixed.length);

// ---------- 6. stamp ----------
try {
  const ident = ea.asarFileIdentity(asarPath);
  if (ident) core.writeUnpackedAsarStamp(ident);
} catch {}

// ---------- 7. asar wins over app/ in Electron, so move it aside ----------
let renamedTo = "";
if (fs.existsSync(asarPath)) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const bak = `${asarPath}.purge-unsealed-${stamp}.bak`;
  try { fs.renameSync(asarPath, bak); renamedTo = bak; }
  catch (e) { log("rename failed:", e.message); }
}

emit({
  ok: !fs.existsSync(asarPath),
  rebuilt,
  prevDir,
  renamedTo,
  patches: tally,
  piAiFixed: piFixed.length,
  appDir,
  aiBase,
  asarStillPresent: fs.existsSync(asarPath),
});
