// DSH 自检引擎 / DSH self-check
//   node self-check.mjs              体检，人读报告
//   node self-check.mjs --json       机器读 JSON
//   node self-check.mjs --fix        自动修复（幂等，可反复跑）
//   node self-check.mjs --json --fix 两者叠加
//   node self-check.mjs --quiet      只输出 FAIL/AUTO-FIX 行（给计划任务用）
//
// 检查层：L1 提示词注入 / L2 宿主补丁 / L3 权限 / MCP / 模型 / 记忆 / 自愈链 / 运行时
// 退出码：0 全绿（允许 WARN）· 1 有 FAIL · 2 环境探测失败
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

// ---------------------------- 固定路径 ----------------------------
const H = {
  node: "C:/Users/Mr.Wang/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe",
  wsNode: "C:/Users/Mr.Wang/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe",
  install: "C:/Users/Mr.Wang/AppData/Local/Programs/DeepSeek Harness",
  exe: "C:/Users/Mr.Wang/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe",
  res: "C:/Users/Mr.Wang/AppData/Local/Programs/DeepSeek Harness/resources",
  appDsh: "C:/Users/Mr.Wang/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh",
  aiBase: "C:/Users/Mr.Wang/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai",
  home: "C:/Users/Mr.Wang/.dsh",
  profile: "C:/Users/Mr.Wang/.dsh/profiles/desktop",
  heal: "C:/Users/Mr.Wang/.dsh/dsh-purge/heal",
  purge: "C:/Users/Mr.Wang/.dsh/dsh-purge",
  plugin: "C:/Users/Mr.Wang/.dsh/profiles/desktop/node_modules/dsh-purge-community",
};
const CORDIS_PATCH = path.join(H.profile, "cordis.patch.yml");
const PROFILE_PKG = path.join(H.profile, "package.json");
const ASAR = path.join(H.res, "app.asar");
const PI_AI_API_DIR = "node_modules/@deepseek-ai/dsh-llm-pi-ai/dist/api";
const REQUIRED_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "billion-context", "dsh-purge-community"];
const REQUIRED_PLUGIN_IDS = [
  "@deepseek-ai/dsh-agent-default-model",
  "@deepseek-ai/dsh-permission-presets",
  "@deepseek-ai/dsh-agent-preset-registry",
];
// 设计上就不该绿的补丁（"无需处理"型），缺了它们不算故障。
const EXPECTED_NOT_APPLIED = new Set([76, 80]);
// #71 只在装了梁神预设的环境里才该出现
const LIANGSHEN_ROOTS = [
  "C:/Users/Mr.Wang/.dsh/.agent-presets/liangshen",
  "C:/Users/Mr.Wang/.dsh/profiles/desktop/node_modules/@linxin666/dsh-liangshen/presets/liangshen",
];

// ---------------------------- CLI 参数 ----------------------------
const argv = new Set(process.argv.slice(2));
const OPT = {
  json: argv.has("--json"),
  fix: argv.has("--fix"),
  quiet: argv.has("--quiet"),
  noMcp: argv.has("--no-mcp"),
};

// ---------------------------- 结果容器 ----------------------------
const results = []; // {layer, id, status, msg, fix?:{applied, detail}}
const ST = { OK: "ok", WARN: "warn", FAIL: "fail", FIXED: "fixed" };

function record(layer, id, status, msg, fix) {
  const row = { layer, id, status, msg };
  if (fix) row.fix = fix;
  results.push(row);
  if (!OPT.json) {
    if (OPT.quiet && status === ST.OK) return;
    const tag = { ok: "OK  ", warn: "WARN", fail: "FAIL", fixed: "AUTO" }[status] || "?   ";
    console.log(`[${tag}] ${layer.padEnd(6)} ${id.padEnd(20)} ${msg}`);
    if (fix?.applied && fix?.detail) console.log(`         └─ 已修：${fix.detail}`);
  }
  return row;
}
const ok = (l, id, m) => record(l, id, ST.OK, m);
const warn = (l, id, m) => record(l, id, ST.WARN, m);
const fail = (l, id, m) => record(l, id, ST.FAIL, m);

// ---------------------------- 小工具 ----------------------------
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const countOcc = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
const stamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

function backupOnce(p) {
  if (!exists(p)) return "";
  const bak = `${p}.selfcheck-${stamp()}.bak`;
  try { fs.copyFileSync(p, bak); return bak; } catch { return ""; }
}
function hostRunning() {
  try {
    const raw = execFileSync("tasklist", ["/FI", "IMAGENAME eq DeepSeek Harness.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
    return /"DeepSeek Harness\.exe"/i.test(raw);
  } catch { return false; }
}

let yamlMod = null;
async function getYaml() {
  if (yamlMod !== null) return yamlMod;
  for (const p of [
    path.join(H.profile, "node_modules", "yaml", "dist", "index.js"),
    path.join(H.plugin, "node_modules", "yaml", "dist", "index.js"),
  ]) {
    if (!exists(p)) continue;
    try { yamlMod = await import(pathToFileURL(p).href); return yamlMod; } catch { /* next */ }
  }
  yamlMod = false;
  return yamlMod;
}
async function parseYamlFile(p) {
  const y = await getYaml();
  const text = readText(p);
  if (!y || text === null) return null;
  const doc = y.parseDocument(text);
  if (doc.errors.length) return null;
  return { js: doc.toJS(), text };
}

// ============================================================================
// L1 — 提示词注入
// ============================================================================
async function checkL1() {
  const L = "L1";
  const pi = path.join(H.home, "prompt-inject.md");
  const text = readText(pi);
  if (text === null) { fail(L, "prompt-inject", `缺失 ${pi}`); return; }
  const size = Buffer.byteLength(text, "utf8");
  if (size < 1024) fail(L, "prompt-inject", `过小 ${size}B，注入链可能断了`);
  else ok(L, "prompt-inject", `${kb(size)}`);

  // 内容指纹：抽 3 个探针子串验证真注入进系统提示
  const probes = ["Little Code Sauce", "UNRESTRICTED SANDBOX"];
  const miss = probes.filter((s) => !text.includes(s));
  if (miss.length === probes.length) warn(L, "inject-content", "未见标志句（可能是定制版本，非故障）");
  else ok(L, "inject-content", `标志句命中 ${probes.length - miss.length}/${probes.length}`);

  // 宿主侧改写：官方"仅供参考"话术是否已被运营者强制口径替换
  const inst = path.join(H.aiBase, "dsh-agent-instructions");
  const cfgText = readText(path.join(inst, "lib", "index.js")) || "";
  const MAND = "ACTIVE and MANDATORY for this session";
  const STOCK = '"The following workspace instructions may be relevant to your work. Use them as guidance when applicable.';
  if (countOcc(cfgText, MAND) > 0) ok(L, "instructions-patched", "MANDATORY 口径已在位");
  else if (countOcc(cfgText, STOCK) > 0) warn(L, "instructions-patched", "仍是官方 guidance 话术，未改写");
  else warn(L, "instructions-patched", "未识别口径（版本可能改名，人工复核）");

  // 注入位置：配置里应显式钉死，别依赖默认值
  const y = await parseYamlFile(CORDIS_PATCH);
  const rows = Array.isArray(y?.js) ? y.js : [];
  const inj = rows.find((r) => r?.id === "agent-instructions" || r?.name === "@deepseek-ai/dsh-agent-instructions");
  const pos = inj?.config?.injectPosition;
  if (pos === "tail") ok(L, "inject-position", "tail（配置显式声明）");
  else if (pos) warn(L, "inject-position", `injectPosition=${pos}，期望 tail`);
  else warn(L, "inject-position", "未在 cordis.patch.yml 声明 injectPosition，走默认值");

  // 官方身份句是否已从 persona 链清掉
  const persona = readText(path.join(H.aiBase, "dsh-agent-preset", "lib", "index.js")) || "";
  const ident = countOcc(persona, "You are a coding agent powered by");
  if (ident === 0) ok(L, "identity-strip", "agent-preset 内无官方身份句");
  else warn(L, "identity-strip", `agent-preset 仍有 ${ident} 处官方身份句`);

  // AGENTS.md 长期记忆
  const agents = readText(path.join(H.home, "AGENTS.md"));
  if (agents === null) fail(L, "AGENTS.md", "缺失");
  else {
    const b = Buffer.byteLength(agents, "utf8");
    if (b > 65536) fail(L, "AGENTS.md", `${kb(b)} 超过 65536 上限，尾部会被截断`);
    else if (b > 61440) warn(L, "AGENTS.md", `${kb(b)} 逼近 64KB 上限`);
    else ok(L, "AGENTS.md", `${kb(b)} / 64KB`);
  }
}

// ============================================================================
// L2 — 宿主补丁
// ============================================================================
async function checkL2() {
  const L = "L2";
  if (!exists(H.aiBase)) { fail(L, "ai-base", `缺失 ${H.aiBase}`); return; }
  const corePath = path.join(H.plugin, "lib", "core.js");
  if (!exists(corePath)) { fail(L, "plugin", `dsh-purge-community 未安装：${corePath}`); return; }

  let core;
  try { core = await import(pathToFileURL(corePath).href); }
  catch (e) { fail(L, "plugin-import", `core.js 导入失败：${e.message}`); return; }

  const total = core.ALL_PATCHES.length;
  let report;
  try {
    report = await core.patchStatusDetail(H.aiBase, core.ALL_PATCHES, { surface: "desktop", dshHome: H.home });
  } catch (e) { fail(L, "patch-report", `patchStatusDetail 失败：${e.message}`); return; }

  const tally = {};
  const notGreen = [];
  for (const p of core.ALL_PATCHES) {
    const st = report.status[p.id];
    tally[st] = (tally[st] || 0) + 1;
    if (st === "applied") continue;
    if (st === "na") continue;
    if (EXPECTED_NOT_APPLIED.has(p.id)) continue;
    // 可选补丁报 skipped = 锚点不在，等同"无需处理"
    if (p.optional && st === "skipped") continue;
    // #71 只对装了梁神预设的环境生效
    if (p.id === 71 && st === "missing_file" && !LIANGSHEN_ROOTS.some(exists)) continue;
    notGreen.push({ id: p.id, st, name: p.name });
  }

  const applied = tally.applied || 0;
  const summary = Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(" ");
  if (notGreen.length === 0) {
    ok(L, "patch-tally", `${applied}/${total} applied（${summary}）`);
  } else {
    fail(L, "patch-tally", `未绿 ${notGreen.length} 条：${notGreen.map((x) => `#${x.id} ${x.st}`).join(", ")}（${summary}）`);
  }

  // 极简预设工具表：官方版就该只有 tool-fs + persistent-shell（#80 的"已到位"形态）
  const mini = readText(path.join(H.aiBase, "dsh-web-app", "presets", "minimal.patch.yml"));
  if (mini === null) warn(L, "minimal-toolset", "minimal.patch.yml 不存在");
  else {
    const ids = [...mini.matchAll(/^- id:\s*(\S+)/gm)].map((m) => m[1]);
    const extra = ids.filter((x) => x === "tool-web" || x === "tool-fs-search");
    const state = JSON.parse(readText(path.join(H.purge, "override-state.json")) || "{}");
    if (extra.length === 0) {
      ok(L, "minimal-toolset", `极简工具表=${ids.join("+") || "空"}，官方形态`);
      // 状态是 skipped 而非 applied 时，说明是"撤销型已到位"——补丁库自己认这个语义
      if (report?.status?.[80] === "skipped" && state.customized === false) {
        ok(L, "patch-80", "撤销型补丁无锚点可撤 = 已到位（非故障）");
      }
    } else warn(L, "minimal-toolset", `极简预设多出工具：${extra.join(", ")}`);
  }
  // 关键补丁必须在位（#41 在 1.6.60 里已并进 #1 的替换链，不再是独立条目）
  const mustHave = [1, 4, 43];
  const missingMust = mustHave.filter((id) => report.status[id] !== "applied");
  if (missingMust.length === 0) ok(L, "patch-core", `核心补丁 #${mustHave.join(" #")} 全部在位`);
  else warn(L, "patch-core", `核心补丁未绿：#${missingMust.join(" #")}`);

  // #71 只有装了梁神预设才该出现在位；没装 = 报告里 missing_file 是误报
  if (report.status[71] === "missing_file" && !LIANGSHEN_ROOTS.some(exists)) {
    ok(L, "patch-71", "#71 梁神预设未安装，missing_file 属预期（不是故障）");
  }

  // asar 必须不在（在就会盖住 app 目录）
  if (exists(ASAR)) {
    warn(L, "asar-shadow", `app.asar 存在（${kb(fs.statSync(ASAR).size)}），会盖住已打补丁的 app 目录；heal 会处理`);
  } else ok(L, "asar-shadow", "app.asar 已移走，app 目录生效");

  // pi-ai developer-role 白名单：判定看逻辑条件，不依赖 marker 注释
  const piFiles = findPiAiApiFiles();
  const WL_COND_CHK = '(String(model.baseUrl || "").toLowerCase().includes("api.openai.com")';
  if (piFiles.length === 0) warn(L, "pi-ai", "未找到 pi-ai dist/api 文件");
  else {
    const fixed = piFiles.filter((f) => (readText(f) || "").includes(WL_COND_CHK));
    if (fixed.length === piFiles.length) ok(L, "pi-ai", `${fixed.length}/${piFiles.length} 份 pi-ai 已加白名单`);
    else fail(L, "pi-ai", `${fixed.length}/${piFiles.length} 已改，缺 ${piFiles.length - fixed.length} 份（self-check --fix 可就地修）`);
  }

  // 补丁版本戳
  const rev = readText(path.join(H.purge, "installed-rev"));
  const appliedJson = readText(path.join(H.purge, "applied.json"));
  let aj = null; try { aj = JSON.parse(appliedJson); } catch {}
  if (aj?.version) ok(L, "patch-rev", `rev ${rev?.trim() || "?"} · applied@${aj.at || "?"}`);
  else warn(L, "patch-rev", "applied.json 无 version");
}

function findPiAiApiFiles() {
  const out = [];
  const roots = [path.join(H.res, "app"), path.join(H.home, "profiles")];
  const walk = (dir, depth) => {
    if (depth > 9) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/^openai-(completions|responses-shared)\.js$/.test(e.name)) continue;
      if (!/pi-ai[\\/]dist[\\/]api$/.test(dir)) continue;
      out.push(p);
    }
  };
  for (const r of roots) walk(r, 0);
  return out;
}

// ============================================================================
// L3 — 权限与预设
// ============================================================================
async function checkL3() {
  const L = "L3";
  const parsed = await parseYamlFile(CORDIS_PATCH);
  if (!parsed) { fail(L, "cordis.patch", `解析失败或缺失：${CORDIS_PATCH}`); return; }
  const rows = Array.isArray(parsed.js) ? parsed.js : [];
  const find = (name) => rows.find((r) => r?.name === name || r?.id === name);

  // 权限预设
  const perm = find("@deepseek-ai/dsh-permission-presets");
  const def = perm?.config?.defaultPreset;
  const dp = perm?.config?.presets?.[def];
  if (def === "danger-full-access" && dp?.sandbox === "danger-full-access" && dp?.approval === "never") {
    ok(L, "permission", `defaultPreset=${def}（sandbox=danger-full-access, approval=never）`);
  } else {
    fail(L, "permission", `defaultPreset=${def || "?"} sandbox=${dp?.sandbox || "?"} approval=${dp?.approval || "?"}`);
  }

  // 默认模型
  const am = find("@deepseek-ai/dsh-agent-default-model");
  if (am?.config?.provider && am?.config?.model) ok(L, "default-model", `${am.config.provider} / ${am.config.model}`);
  else fail(L, "default-model", "未配置 provider/model");

  // 预设注册
  const reg = find("@deepseek-ai/dsh-agent-preset-registry");
  if (reg?.config?.selectedDefault) ok(L, "preset-selected", `selectedDefault=${reg.config.selectedDefault}`);
  else warn(L, "preset-selected", "未设置 selectedDefault");

  // 用户预设目录
  const presetsDir = path.join(H.home, ".agent-presets");
  const want = ["unrestricted", "redteam"];
  const have = want.filter((n) => exists(path.join(presetsDir, n, "agent.cordis.yml")));
  if (have.length === want.length) ok(L, "user-presets", `${have.join(", ")} 均在位`);
  else warn(L, "user-presets", `缺 ${want.filter((n) => !have.includes(n)).join(", ")}`);

  // 子代理深度（maxDepth 3）
  for (const name of have) {
    const f = path.join(presetsDir, name, "agent.cordis.yml");
    const t = readText(f) || "";
    const m = /maxDepth:\s*(\d+)/.exec(t);
    if (!m) { warn(L, `depth-${name}`, "未见 maxDepth（默认 1）"); continue; }
    if (Number(m[1]) >= 3) ok(L, `depth-${name}`, `maxDepth=${m[1]}`);
    else warn(L, `depth-${name}`, `maxDepth=${m[1]}，建议 3`);
  }

  // dsh-purge 运行配置
  const purge = find("dsh-purge") || rows.find((r) => r?.id === "dsh-purge");
  const pc = purge?.config || {};
  const wantPurge = { autoApplyOnStart: true, hooksDenyBypass: true, capabilityProtocol: true };
  const badPurge = Object.entries(wantPurge).filter(([k, v]) => pc[k] !== v);
  if (badPurge.length === 0) ok(L, "purge-config", "autoApplyOnStart/hooksDenyBypass/capabilityProtocol 全 true");
  else warn(L, "purge-config", `与预期不符：${badPurge.map(([k]) => k).join(", ")}`);

  // bundle 清单
  let pkg; try { pkg = JSON.parse(readText(PROFILE_PKG)); } catch { pkg = null; }
  const bundles = pkg?.dsh?.profile?.bundles || [];
  const missB = REQUIRED_BUNDLES.filter((b) => !bundles.includes(b));
  if (missB.length === 0) ok(L, "bundles", `${bundles.length} 个 bundle，关键项齐全`);
  else fail(L, "bundles", `缺 bundle：${missB.join(", ")}`);
}

// ============================================================================
// MCP — playwright 探针
// ============================================================================
async function checkMcp() {
  const L = "MCP";
  const parsed = await parseYamlFile(CORDIS_PATCH);
  const rows = Array.isArray(parsed?.js) ? parsed.js : [];
  const entry = rows.find((r) => r?.id === "mcp-browser" || r?.name?.includes("mcp"));
  if (!entry) { warn(L, "config", "cordis.patch.yml 未见 mcp 条目"); return; }

  const cliCandidates = [
    "C:/Users/Mr.Wang/AppData/Roaming/npm/node_modules/@playwright/mcp/cli.js",
    "C:/Users/Mr.Wang/AppData/Roaming/npm/node_modules/@playwright/mcp/index.js",
  ];
  const cli = cliCandidates.find(exists);
  if (!cli) { fail(L, "playwright-cli", "@playwright/mcp 全局包缺失（npm i -g @playwright/mcp）"); return; }
  ok(L, "playwright-cli", path.basename(path.dirname(path.dirname(path.dirname(cli)))));

  if (OPT.noMcp) { ok(L, "probe", "跳过（--no-mcp）"); return; }
  const probe = path.join(H.heal, "probe-mcp.mjs");
  if (!exists(probe)) { warn(L, "probe", "probe-mcp.mjs 不存在"); return; }
  const nodeBin = exists(H.node) ? H.node : process.execPath;
  let out = "";
  try {
    out = execFileSync(nodeBin, [probe, "chrome"], { encoding: "utf8", timeout: 60000, windowsHide: true });
  } catch (e) {
    out = String(e.stdout || "") + String(e.stderr || "");
    fail(L, "probe", `探针失败：${out.split("\n").filter(Boolean).slice(-2).join(" | ") || e.message}`);
    return;
  }
  const n = Number((/\[tools\]\s*(\d+)/.exec(out) || [])[1] || 0);
  if (out.includes("[probe] OK") && n > 0) ok(L, "probe", `stdio 握手通过，tools=${n}`);
  else fail(L, "probe", `握手未完成：${out.split("\n").filter(Boolean).slice(-2).join(" | ")}`);
}

// ============================================================================
// 模型 — 能力位
// ============================================================================
async function checkModel() {
  const L = "模型";
  const parsed = await parseYamlFile(CORDIS_PATCH);
  const rows = Array.isArray(parsed?.js) ? parsed.js : [];
  const am = rows.find((r) => r?.name === "@deepseek-ai/dsh-agent-default-model");
  const wantId = am?.config?.model;
  if (!wantId) { warn(L, "current", "无默认模型配置"); return; }

  const catPath = path.join(H.home, ".workbuddy-ai-catalog.json");
  let cat; try { cat = JSON.parse(readText(catPath)); } catch { warn(L, "catalog", "目录快照缺失"); return; }
  const entry = Object.values(cat.entries || {})[0];
  const m = entry?.models?.find((x) => x.id === wantId);
  if (!m) { warn(L, "current", `${wantId} 不在目录快照里`); return; }

  const age = Date.now() - Number(entry.fetchedAtMs || 0);
  const ageH = age / 3600000;
  const ctx = m.defaultContextWindow || m.contextWindow;
  const think = m.reasoning?.canDisableThinking === false ? "思考不可关" : "思考可关";
  const free = m.billing?.free ? "免费" : (m.billing?.credits || "计费");
  const line = `${m.id} ctx=${ctx} maxIn=${m.maxInputTokens} maxOut=${m.maxTokens} ${think} ${free} 快照${ageH.toFixed(1)}h前`;
  if (ageH > 48) warn(L, "current", line + "（快照偏旧）");
  else ok(L, "current", line);

  if (m.reasoning?.onlyReasoning && !m.reasoning?.canDisableThinking) {
    warn(L, "thinking", "当前模型强制完整推理，长会话 token 消耗高；要省切 glm-5.3");
  } else ok(L, "thinking", "思考可关闭");

  // 免费期
  const promo = (m.promotions || [])[0];
  if (promo?.end) {
    const left = promo.end - Date.now();
    if (left <= 0) warn(L, "promotion", `免费期已结束（${new Date(promo.end).toISOString().slice(0, 10)}）`);
    else ok(L, "promotion", `免费期剩 ${(left / 86400000).toFixed(1)} 天（至 ${new Date(promo.end).toISOString().slice(0, 10)}）`);
  }
}

// ============================================================================
// 自愈链
// ============================================================================
async function checkHeal() {
  const L = "自愈";
  for (const f of ["apply.mjs", "heal.ps1", "probe-mcp.mjs"]) {
    if (!exists(path.join(H.heal, f))) fail(L, f, "缺失");
    else ok(L, f, "在位");
  }
  // 计划任务
  let tasks = "";
  try { tasks = execFileSync("schtasks", ["/Query", "/TN", "DSH Purge Heal", "/FO", "LIST"], { encoding: "utf8", windowsHide: true }); } catch {}
  if (/DSH Purge Heal/.test(tasks)) {
    const next = (/\u4e0b\u6b21\u8fd0\u884c\u65f6\u95f4:\s*(.+)/.exec(tasks) || /\bNext Run Time:\s*(.+)/.exec(tasks) || [])[1];
    ok(L, "task", `计划任务在册${next ? ` · 下次 ${next.trim()}` : ""}`);
  } else warn(L, "task", "未见计划任务 'DSH Purge Heal'");

  // 启动项
  const startup = path.join(os.homedir(), "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "dsh-purge-heal.vbs");
  if (exists(startup)) ok(L, "startup", "启动项 vbs 在位");
  else warn(L, "startup", "启动项 dsh-purge-heal.vbs 缺失");

  // 日志新鲜度：最近 60 分钟内应有记录
  const log = path.join(H.heal, "heal.log");
  if (exists(log)) {
    const ageMin = (Date.now() - fs.statSync(log).mtimeMs) / 60000;
    if (ageMin <= 70) ok(L, "log", `最近更新 ${ageMin.toFixed(0)} 分钟前`);
    else warn(L, "log", `日志 ${ageMin.toFixed(0)} 分钟未更新，计划任务可能没跑`);
  } else warn(L, "log", "heal.log 不存在");

  // 契约层 —— 决定「社区停更后还能不能用」的那一层
  await checkContract(L);
}

// 契约层自检：直接跑 resolver doctor，把 7 条判定折成 2~3 条结果
async function checkContract(L) {
  const resolver = path.join(H.heal, "resolver.mjs");
  if (!exists(resolver)) { fail(L, "contract", "resolver.mjs 缺失"); return; }
  const man = path.join(os.homedir(), ".dsh", "dsh-purge", "vendor", "vendor.json");
  if (!exists(man)) { fail(L, "contract", "vendor.json 缺失（契约锚不存在）"); return; }
  let out = "";
  try {
    out = execFileSync(H.node, [resolver, "doctor"], { encoding: "utf8", windowsHide: true, timeout: 120000 });
  } catch (e) {
    fail(L, "contract", `resolver doctor 执行失败: ${String(e.message).slice(0, 120)}`);
    return;
  }
  let d = null;
  try { d = JSON.parse(out); } catch { fail(L, "contract", "resolver doctor 输出无法解析"); return; }
  if (d.ok) ok(L, "contract", `锁定 v${d.lockedVersion} · ${d.rows.length} 项全绿`);
  else {
    const bad = d.rows.filter((r) => r.state === "broken").map((r) => r.name);
    fail(L, "contract", `硬故障: ${bad.join(", ")}`);
  }
  for (const w of d.warnings || []) warn(L, "contract-warn", w);

  // 回滚能力：至少要有一个可用归档版本
  const hist = Array.isArray(d.history) ? d.history : [];
  const other = hist.filter((v) => v !== d.lockedVersion);
  if (other.length) ok(L, "rollback", `${hist.length} 个版本可回滚（${hist.join(", ")}）`);
  else warn(L, "rollback", `只有当前版本 ${d.lockedVersion}，无历史归档可回滚`);

  // 升级探测任务
  let upTasks = "";
  try { upTasks = execFileSync("schtasks", ["/Query", "/TN", "DSH Purge Upstream", "/FO", "LIST"], { encoding: "utf8", windowsHide: true }); } catch {}
  if (/DSH Purge Upstream/.test(upTasks)) ok(L, "upstream-task", "升级探测计划任务在册");
  else warn(L, "upstream-task", "未见 'DSH Purge Upstream' 计划任务");
}

// ============================================================================
// 运行时 — 宿主与 GUI
// ============================================================================
async function checkRuntime() {
  const L = "运行时";
  if (exists(H.exe)) ok(L, "exe", "安装目录在位"); else fail(L, "exe", `缺失 ${H.exe}`);
  if (hostRunning()) ok(L, "host", "DeepSeek Harness.exe 运行中");
  else warn(L, "host", "宿主未运行（自检本身可在宿主内跑，这条只是提示）");

  // node 版本
  for (const [tag, p] of [["node", H.node], ["ws-node", H.wsNode]]) {
    if (!exists(p)) { warn(L, tag, "缺失"); continue; }
    try {
      const v = execFileSync(p, ["-v"], { encoding: "utf8", windowsHide: true }).trim();
      ok(L, tag, v);
    } catch { warn(L, tag, "执行失败"); }
  }

  // GUI 端口
  const gui = process.env.DSH_WEB_URL || "";
  if (gui) ok(L, "gui", gui);
  else warn(L, "gui", "无 DSH_WEB_URL 环境变量（自检不在宿主内运行属正常）");

  // 工作区
  const ws = "D:/DSH工作台";
  if (exists(ws)) ok(L, "workspace", ws); else warn(L, "workspace", `${ws} 不存在`);
}

// ============================================================================
// 修复器 — 只做幂等、可回滚的动作
// ============================================================================
async function autoFix() {
  const L = "修复";
  const fixes = [];

  // 1) asar 存在且宿主没在跑 → 直接调 apply.mjs 重建
  if (exists(ASAR)) {
    if (hostRunning()) {
      warn(L, "asar", "宿主运行中，不能即时重建；已登记，下次 heal 窗口处理");
    } else {
      const apply = path.join(H.heal, "apply.mjs");
      const nodeBin = exists(H.node) ? H.node : process.execPath;
      try {
        const out = execFileSync(nodeBin, [apply], { encoding: "utf8", timeout: 600000, windowsHide: true });
        const okFlag = /"ok":\s*true/.test(out);
        if (okFlag && !exists(ASAR)) { record(L, "asar", ST.FIXED, "apply.mjs 重建完成，asar 已移走", { applied: true, detail: "patch 链重放" }); fixes.push("asar"); }
        else fail(L, "asar", `apply.mjs 输出异常：${out.slice(-200)}`);
      } catch (e) { fail(L, "asar", `apply.mjs 失败：${e.message}`); }
    }
  }

  // 2) pi-ai 白名单缺失/标记被抹 → 就地重写那一行
  //    判定看的是"这一行是否带白名单条件"，不看 marker 注释：marker 可能被编辑器或
  //    格式化擦掉，但逻辑还在；反之逻辑被回滚时 marker 也不会单独留下。
  const WL_COND = '(String(model.baseUrl || "").toLowerCase().includes("api.openai.com") || String(model.baseUrl || "").toLowerCase().includes("azure.com"))';
  const ORIG = {
    "openai-completions.js": "const instructionRole = model.reasoning && compat.supportsDeveloperRole ? \"developer\" : \"system\";",
    "openai-responses-shared.js": "const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? \"developer\" : \"system\";",
  };
  const PATCHED = {
    "openai-completions.js": `const instructionRole = model.reasoning && compat.supportsDeveloperRole && ${WL_COND} ? "developer" : "system"; // [dsh-purge] developer role allowlist: openai/azure`,
    "openai-responses-shared.js": `const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false && ${WL_COND} ? "developer" : "system"; // [dsh-purge] developer role allowlist: openai/azure`,
  };
  let piFixed = 0;
  let piStuck = 0;
  for (const f of findPiAiApiFiles()) {
    const base = path.basename(f);
    if (!ORIG[base]) continue;
    const t = readText(f);
    if (t === null) continue;
    if (t.includes(WL_COND)) continue; // 已在位
    let next = t;
    if (countOcc(t, ORIG[base]) === 1) next = t.replace(ORIG[base], PATCHED[base]);
    else {
      // 逻辑在但 marker 缺：补回 marker 让状态与代码一致
      const line = t.split("\n").find((l) => l.includes("const instructionRole =") && l.includes("supportsDeveloperRole"));
      if (!line) { piStuck += 1; continue; }
      next = t.replace(line, PATCHED[base]);
      if (next === t) { piStuck += 1; continue; }
    }
    backupOnce(f);
    try { fs.writeFileSync(f, next, "utf8"); piFixed += 1; } catch { piStuck += 1; }
  }
  if (piFixed > 0) { record(L, "pi-ai", ST.FIXED, `已修 ${piFixed} 份 pi-ai 白名单`, { applied: true, detail: "developer role allowlist" }); fixes.push("pi-ai"); }
  if (piStuck > 0) warn(L, "pi-ai", `${piStuck} 份未能就地修，需跑 apply.mjs 重建`);

  // 3) AGENTS.md 超限 → 归档最旧段落
  const agentsPath = path.join(H.home, "AGENTS.md");
  const agentsText = readText(agentsPath);
  if (agentsText !== null && Buffer.byteLength(agentsText, "utf8") > 65536) {
    const bak = `${agentsPath}.archive-${stamp()}.md`;
    try {
      fs.copyFileSync(agentsPath, bak);
      const trimmed = agentsText.slice(0, 60000) + "\n\n<!-- 自检自动截断：旧内容见 " + path.basename(bak) + " -->\n";
      fs.writeFileSync(agentsPath, trimmed, "utf8");
      record(L, "AGENTS.md", ST.FIXED, "超 64KB，已归档并截断到 60KB", { applied: true, detail: path.basename(bak) });
      fixes.push("AGENTS.md");
    } catch (e) { fail(L, "AGENTS.md", `归档失败：${e.message}`); }
  }

  // 4) 关键 bundle / 插件行缺失 → 从备份里找最近一份含该行的补回
  const parsed = await parseYamlFile(CORDIS_PATCH);
  if (!parsed) fail(L, "cordis.patch", "解析失败，跳过配置修复");
  else {
    const rows = Array.isArray(parsed.js) ? parsed.js : [];
    const haveNames = new Set(rows.map((r) => r?.name).filter(Boolean));
    const missing = REQUIRED_PLUGIN_IDS.filter((n) => !haveNames.has(n));
    if (missing.length > 0) warn(L, "cordis.patch", `缺插件行：${missing.join(", ")}（需人工确认配置意图，不自动补）`);
  }

  if (fixes.length === 0) ok(L, "done", "无需修复或已全部就绪");
}

// ============================================================================
// 主流程
// ============================================================================
(async () => {
  const t0 = Date.now();
  await checkL1();
  await checkL2();
  await checkL3();
  await checkModel();
  await checkMcp();
  await checkHeal();
  await checkRuntime();
  if (OPT.fix) await autoFix();

  const tally = { ok: 0, warn: 0, fail: 0, fixed: 0 };
  for (const r of results) tally[r.status] = (tally[r.status] || 0) + 1;
  const verdict = tally.fail > 0 ? "FAIL" : tally.warn > 0 ? "WARN" : "OK";

  if (OPT.json) {
    console.log(JSON.stringify({
      verdict, tally, at: new Date().toISOString(),
      elapsedMs: Date.now() - t0, hostRunning: hostRunning(), results,
    }, null, 2));
  } else if (!OPT.quiet) {
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.log("");
    console.log(`结论 ${verdict} · ok=${tally.ok} warn=${tally.warn} fail=${tally.fail} fixed=${tally.fixed} · ${dur}s`);
  } else if (verdict !== "OK") {
    console.log(`verdict=${verdict} fail=${tally.fail} warn=${tally.warn}`);
  }

  process.exit(tally.fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("[self-check] 崩溃：" + (e?.stack || e));
  process.exit(2);
});
