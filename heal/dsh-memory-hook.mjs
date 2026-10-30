/**
 * dsh-memory-hook — 会话停止时把本轮要点写回长期记忆。
 *
 * 为什么需要它：AGENTS.md 每轮注入，但我此前只能手动往里写。会话一结束，本轮
 * 摸清的路径、踩过的坑、改过的配置就散了。这个插件挂在 `workspace/session-stop`
 * 上（会话被停止/归档时触发，payload 是 `{ sessionId }`），把会话日志里值得留存的
 * 事实追加进 `$DSH_HOME/AGENTS.md` 的「会话记忆 · 自动追加」区。
 *
 * 落盘位置的选择依据：`dsh-agent-instructions`（L17 `DEFAULT_INSTRUCTION_FILE_CANDIDATES
 * = ["AGENTS.md", "CLAUDE.md"]`，L168 `USER_GLOBAL_FILE = "AGENTS.md"`）每轮把
 * `$DSH_HOME/AGENTS.md` 注入上下文，所以写它就是写长期记忆。
 *
 * 只追加、只在自己那一节里动，正文其余部分不碰。会话日志解析失败时静默跳过，
 * 绝不因为记忆失败而影响会话本身的停止流程。
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const name = "dsh-memory-hook";
export const inject = ["sessionQuery"];

/** 这一节之前的内容都归人工维护，插件只在标记之后追加。 */
const SECTION = "<!-- dsh-memory-hook:auto -->";
const MAX_FILE_BYTES = 60000;          // 留出余量（注入上限 65536）
const MAX_ENTRIES = 60;                // 自动区最多保留多少条
const MAX_ENTRY_CHARS = 400;           // 单条摘要上限

/**
 * 定位真正的标记：取**最后一个**。
 *
 * 为什么不能用 indexOf：文档正文里很可能引用这个标记（比如本节自己的说明文字），
 * 那样 indexOf 会命中正文里的那次引用，把条目追加到文档中间，还会破坏正文。
 * 真标记永远由本插件追加在文件末尾，所以 lastIndexOf 才是正确的锚点。
 */
function sectionAt(text) {
  return text.lastIndexOf(SECTION);
}

function dshHome() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE || "", ".dsh");
}

function agentsFile() {
  return join(dshHome(), "AGENTS.md");
}

/** 从事件流里抽出人写的那几句话（用户消息），它们是意图的原始记录。 */
function userMessages(events) {
  const out = [];
  for (const ev of events) {
    if (ev?.type !== "user/message") continue;
    const src = ev.data?.source;
    if (src?.kind === "agent-instructions") continue;   // 自己注入的，不算
    if (src?.kind === "subagent") continue;
    const content = ev.data?.content;
    if (typeof content === "string") out.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) if (typeof part?.text === "string") out.push(part.text);
    }
  }
  return out;
}

/** 把会话压成一条可留存的行：标题 + 用户说的最后几句。 */
function condense(sessionId, session, events) {
  const title = (session?.title || "").trim();
  const users = userMessages(events);
  const asked = users
    .slice(-3)
    .map((t) => t.replace(/\s+/gu, " ").trim())
    .filter((t) => t.length > 0)
    .map((t) => (t.length > 90 ? t.slice(0, 90) + "…" : t));

  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const label = title || asked[0] || "(无标题)";
  const body = asked.length > 1 ? " · 追问：" + asked.slice(1).join(" / ") : "";
  const line = `- ${stamp} [${sessionId.slice(0, 8)}] ${label}${body}`;
  return line.length > MAX_ENTRY_CHARS ? line.slice(0, MAX_ENTRY_CHARS) + "…" : line;
}

function ensureSection(text) {
  const at = sectionAt(text);
  if (at >= 0) return text;
  const tail = text.endsWith("\n") ? "" : "\n";
  return text + tail + "\n## 会话记忆 · 自动追加\n\n" + SECTION + "\n";
}

/** 只保留自动区里最后 MAX_ENTRIES 条。 */
function trimSection(text) {
  const at = sectionAt(text);
  if (at < 0) return text;
  const head = text.slice(0, at + SECTION.length);
  const rest = text.slice(at + SECTION.length);
  const lines = rest.split("\n").filter((l) => l.trim().length > 0);
  const kept = lines.slice(-MAX_ENTRIES);
  return head + "\n" + kept.join("\n") + "\n";
}

async function record(ctx, sessionId) {
  const file = agentsFile();
  let loaded;
  try {
    loaded = await ctx.sessionQuery.readSession(sessionId);
  } catch (error) {
    ctx.logger?.warn?.(`memory-hook: 读会话 ${sessionId} 失败，跳过 — ${String(error)}`);
    return;
  }
  const entry = condense(sessionId, loaded.session, loaded.events ?? []);

  if (!existsSync(file)) {
    try { writeFileSync(file, "# 长期记忆\n\n## 会话记忆 · 自动追加\n\n" + SECTION + "\n" + entry + "\n", "utf8"); }
    catch (error) { ctx.logger?.warn?.(`memory-hook: 建 ${file} 失败 — ${String(error)}`); }
    return;
  }

  let text;
  try { text = readFileSync(file, "utf8"); } catch (error) {
    ctx.logger?.warn?.(`memory-hook: 读 ${file} 失败 — ${String(error)}`);
    return;
  }

  text = ensureSection(text);
  if (text.includes(entry)) return;              // 同一条不重复追加
  text = trimSection(text);

  const at = sectionAt(text);
  const head = text.slice(0, at + SECTION.length);
  const rest = text.slice(at + SECTION.length).replace(/^\n+/u, "");
  text = head + "\n" + entry + (rest ? "\n" + rest : "") + "\n";

  // 注入有 64KB 上限，自动区不能把文件顶爆
  let bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_FILE_BYTES) {
    text = trimSection(text);
    bytes = Buffer.byteLength(text, "utf8");
  }
  if (bytes > MAX_FILE_BYTES) {
    ctx.logger?.warn?.(`memory-hook: ${file} 仍为 ${bytes} 字节，放弃本次追加`);
    return;
  }

  try { writeFileSync(file, text, "utf8"); }
  catch (error) { ctx.logger?.warn?.(`memory-hook: 写 ${file} 失败 — ${String(error)}`); }
}

export function apply(ctx) {
  ctx.effect(() => {
    const off = ctx.on("workspace/session-stop", async ({ sessionId }) => {
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      await record(ctx, sessionId);
    });
    return () => off();
  }, "memory-hook.sessionStop()");
}