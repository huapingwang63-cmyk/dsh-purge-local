// 回归：验证 dsh-memory-hook 在「正文里含标记字面量」时仍然写到正确位置。
// lastIndexOf 修复的验收用例。
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from "node:fs";

const HOOK = "file:///C:/Users/Mr.Wang/.dsh/dsh-purge/heal/dsh-memory-hook.mjs";
const AGENTS = "C:\\Users\\Mr.Wang\\.dsh\\AGENTS.md";
const BACKUP = AGENTS + ".regress-backup";
const MARKER = "<!-- dsh-memory-hook:auto -->";

const mod = await import(HOOK);

if (!existsSync(BACKUP)) copyFileSync(AGENTS, BACKUP);
const original = readFileSync(AGENTS, "utf8");

// 构造对抗场景：正文中间故意塞一个标记字面量，末尾放真标记
const DECOY = "## 一个爱引用标记的章节\n\n这段话里提到了 " + MARKER + " 这个标记，作为诱饵。\n\n";
const at = original.lastIndexOf(MARKER);
const adversarial = original.slice(0, at) + DECOY + original.slice(at);

const handlers = new Map();
const warns = [];
const ctx = {
  logger: { warn: (m) => warns.push(m) },
  effect: (fn) => { const off = fn(); return off ?? (() => {}); },
  on: (e, f) => { handlers.set(e, f); return () => handlers.delete(e); },
  sessionQuery: {
    readSession: async () => ({
      session: { title: "回归 · 诱饵标记" },
      inheritedEventCount: 0,
      events: [{ type: "user/message", data: { source: { kind: "user" }, content: "验证 lastIndexOf 修复" } }],
    }),
  },
};

try {
  writeFileSync(AGENTS, adversarial, "utf8");
  mod.apply(ctx);
  await handlers.get("workspace/session-stop")({ sessionId: "regress-decoy-0001" });

  const after = readFileSync(AGENTS, "utf8");
  const entries = after.split(MARKER);
  const checks = [];

  // 条目必须在最后一个标记之后（即整段末尾），不能在诱饵后面
  const lastMarkerAt = after.lastIndexOf(MARKER);
  const tail = after.slice(lastMarkerAt);
  checks.push(["条目写在末尾真标记之后", tail.includes("回归 · 诱饵标记")]);
  checks.push(["条目带时间戳与会话 id", /- \d{4}-\d{2}-\d{2} \d{2}:\d{2} \[regress-\]/.test(tail)]);
  checks.push(["诱饵位置没有被插入条目", !after.split(MARKER)[1].includes("回归 · 诱饵标记")]);
  checks.push(["诱饵正文完好", after.includes("作为诱饵")]);
  checks.push(["标记只有两个（诱饵 + 真）", (after.match(new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length === 2]);
  checks.push(["无 warn", warns.length === 0]);

  let bad = 0;
  for (const [n, ok] of checks) { console.log((ok ? "  PASS " : "  FAIL ") + n); if (!ok) bad++; }
  if (warns.length) console.log("  warns:", warns.join(" | "));
  console.log(bad === 0 ? "VERDICT: ALL PASS (lastIndexOf 修复有效)" : `VERDICT: ${bad} FAILED`);
  process.exitCode = bad === 0 ? 0 : 1;
} finally {
  copyFileSync(BACKUP, AGENTS);
  unlinkSync(BACKUP);
  console.log("AGENTS.md 已还原");
}