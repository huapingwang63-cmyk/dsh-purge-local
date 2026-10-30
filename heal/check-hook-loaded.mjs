// 用宿主的 cordis loader 组合 profile 树，确认 memory-hook 是否进树、能否 import。
// 这能区分「配置没被加载」和「事件没触发」两种失败。
import { resolve } from "node:path";

const APP = "C:\\Users\\Mr.Wang\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app\\dsh";
const PROFILE = "C:\\Users\\Mr.Wang\\.dsh\\profiles\\desktop";

// 1. 读 profile 的三层：bundle 自带 patch → cordis.patch.yml
const { readFileSync } = await import("node:fs");
const { createRequire } = await import("node:module");
const req = createRequire(resolve(PROFILE, "package.json"));

let YAML;
try {
  YAML = await import("file:///" + resolve(PROFILE, "node_modules/yaml/dist/index.js").replace(/\\/gu, "/"));
  console.log("PASS  yaml 模块可用");
} catch (e) { console.log("FAIL  yaml 模块:", String(e)); process.exit(1); }

const patchText = readFileSync(resolve(PROFILE, "cordis.patch.yml"), "utf8");
const doc = YAML.parseDocument(patchText);
console.log(`PASS  cordis.patch.yml 解析 errors=${doc.errors.length}, entries=${doc.toJS().length}`);

const entries = doc.toJS();
const mh = entries.find((e) => e.id === "memory-hook");
console.log(mh ? `PASS  memory-hook 在 patch 树里: ${mh.name}` : "FAIL  memory-hook 不在树里");

// 2. 插件能否被 import（宿主用的是 ESM 动态 import）
const hookPath = mh?.name;
if (hookPath) {
  try {
    const mod = await import("file:///" + hookPath.replace(/\\/gu, "/"));
    console.log(`PASS  插件可 import: name=${mod.name}, inject=${JSON.stringify(mod.inject)}, apply=${typeof mod.apply}`);
  } catch (e) {
    console.log("FAIL  插件 import 失败:", String(e));
  }
}

// 3. inject 的服务名是否是宿主真有的服务 —— 查 dsh-session-query
const sqPath = resolve(APP, "node_modules/@deepseek-ai/dsh-session-query/lib/index.js");
try {
  const src = readFileSync(sqPath, "utf8");
  const m = /super\(ctx,\s*"([^"]+)"/u.exec(src);
  console.log(m ? `PASS  session-query 注册的服务名: "${m[1]}"` : "WARN  没找到 super(ctx, \"...\")");
  console.log(`      memory-hook 声明 inject=["sessionQuery"] 与实际 ${m?.[1] === "sessionQuery" ? "一致" : "不一致!"}`);
} catch (e) { console.log("WARN  读 session-query 失败:", String(e)); }

// 4. 事件名核对
const schedPath = resolve(APP, "node_modules/@deepseek-ai/dsh-schedule/lib/index.js");
try {
  const src = readFileSync(schedPath, "utf8");
  const hit = src.includes('ctx.on("workspace/session-stop"');
  console.log(hit ? 'PASS  宿主中存在 "workspace/session-stop" 的标准用法' : 'WARN  没找到该事件用法');
} catch (e) { console.log("WARN  读 schedule 失败:", String(e)); }