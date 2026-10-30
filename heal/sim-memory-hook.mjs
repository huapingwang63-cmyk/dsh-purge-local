// 离线驱动 dsh-memory-hook 的完整流程：伪造 ctx + 会话日志，验证 AGENTS.md 真的被写对。
// 不重启 DSH 就能证明插件行为，改完再重启验收。
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";

const HOOK = "file:///C:/Users/Mr.Wang/.dsh/dsh-purge/heal/dsh-memory-hook.mjs";
const AGENTS = "C:\\Users\\Mr.Wang\\.dsh\\AGENTS.md";
const BACKUP = AGENTS + ".sim-backup";

const mod = await import(HOOK);

// ---- 伪造一个最小 ctx ----
const handlers = new Map();
const warns = [];
const ctx = {
  logger: { warn: (m) => warns.push(m) },
  effect: (fn) => { const off = fn(); return off ?? (() => {}); },
  on: (evt, fn) => { handlers.set(evt, fn); return () => handlers.delete(evt); },
  sessionQuery: {
    readSession: async (id) => ({
      session: { title: "回归测试 · memory-hook" },
      inheritedEventCount: 0,
      events: [
        { type: "user/message", data: { source: { kind: "agent-instructions" }, content: "这段是我注入的，不该被记" } },
        { type: "user/message", data: { source: { kind: "user" }, content: "把 GUI token 接进 Playwright" } },
        { type: "assistant/message", data: { content: "ok" } },
        { type: "user/message", data: { source: { kind: "user" }, content: "接，顺便把剩下两件事一起做了" } },
      ],
    }),
  },
};

// ---- 备份 AGENTS.md，跑一遍，再比对 ----
if (!existsSync(BACKUP)) copyFileSync(AGENTS, BACKUP);
const before = readFileSync(AGENTS, "utf8");

mod.apply(ctx);
const stopHandler = handlers.get("workspace/session-stop");
console.log("注册的事件:", [...handlers.keys()].join(", "));
if (!stopHandler) { console.error("FAIL: 没注册 workspace/session-stop"); process.exit(1); }

await stopHandler({ sessionId: "sim-0000-1111-2222-333333333333" });

const after = readFileSync(AGENTS, "utf8");
console.log("文件增长:", after.length - before.length, "字符");
console.log("warns:", warns.length ? warns.join(" | ") : "(无)");

// ---- 断言 ----
const checks = [];
checks.push(["自动区标记已建立", after.includes("<!-- dsh-memory-hook:auto -->")]);
checks.push(["标题已记录", after.includes("回归测试 · memory-hook")]);
checks.push(["用户原话已记录", after.includes("接，顺便把剩下两件事一起做了")]);
checks.push(["注入内容未被记录", !after.includes("这段是我注入的，不该被记")]);
checks.push(["原有正文未被破坏", before.split("## 会话记忆")[0].trim().slice(0, 200) === after.split("## 会话记忆")[0].trim().slice(0, 200)]);

// ---- 幂等：再跑一次，不该重复 ----
await stopHandler({ sessionId: "sim-0000-1111-2222-333333333333" });
const again = readFileSync(AGENTS, "utf8");
checks.push(["重复会话不重复追加", again === after]);

let bad = 0;
for (const [name, ok] of checks) { console.log((ok ? "  PASS " : "  FAIL ") + name); if (!ok) bad++; }
console.log(bad === 0 ? "VERDICT: ALL PASS" : `VERDICT: ${bad} FAILED`);

// 还原
copyFileSync(BACKUP, AGENTS);
console.log("AGENTS.md 已还原到测试前状态");
process.exit(bad === 0 ? 0 : 1);