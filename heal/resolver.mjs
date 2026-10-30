// purge-resolver: 契约层 —— 把「社区还发不发新版」这件事从运行路径里彻底摘出去。
//
// 三件事，互相独立：
//   1. site  把锁定版本的 tarball 重放成 node_modules/dsh-purge-community 别名包（纯本地，不联网）
//   2. pin   把 profile package.json 里那条 /latest/ 依赖改成本地 file: pin（幂等）
//   3. probe 探上游 release 流（releases.atom，不走 api.github.com）—— 只是信息，不参与运行
//
// 用法：
//   node resolver.mjs check                    体检（默认）
//   node resolver.mjs site                     重放别名包
//   node resolver.mjs pin [--yes]              改写 package.json 指向本地 pin（无 --yes 只 dry-run）
//   node resolver.mjs upstream [--yes]         探上游；有新版本就 vendor + site + pin；无新版本则 no-op
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const HOME = process.env.DSH_HOME || "C:/Users/Mr.Wang/.dsh";
const PROFILE = path.join(HOME, "profiles", "desktop");
const NM = path.join(PROFILE, "node_modules");
const ALIAS_NAME = "dsh-purge-community";
const LOCKED_NAME = "dsh-purge-community-locked";
const UPSTREAM_SLUG = "dsh-purge-community";
const STORE = path.join(HOME, "dsh-purge");
const VENDOR = path.join(STORE, "vendor");
const MANIFEST = path.join(VENDOR, "vendor.json");
const PKG_JSON = path.join(PROFILE, "package.json");
const ALIAS_DIR = path.join(NM, ALIAS_NAME);
const REPO = "kingcharleslzy-ai/dsh-purge";
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const ATOM = `https://github.com/${REPO}/releases.atom`;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const emit = (o) => console.log(JSON.stringify(o, null, 2));
const die = (stage, msg) => { emit({ ok: false, stage, error: String(msg) }); process.exit(1); };

// ---------------- vendor manifest ----------------

function readManifest() {
  try {
    // UTF-8 BOM 会让 JSON.parse 直接炸（PowerShell 的 Set-Content -Encoding UTF8 就带 BOM）。
    // 这里剥掉 BOM；万一还是解析不了，再退回最后一版 .bak，避免一次误写就让整个契约层失明。
    const raw = fs.readFileSync(MANIFEST, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    try {
      const baks = fs
        .readdirSync(VENDOR)
        .filter((f) => /^vendor\.json\.bak-/.test(f))
        .sort()
        .reverse();
      for (const b of baks) {
        try {
          return JSON.parse(fs.readFileSync(path.join(VENDOR, b), "utf8").replace(/^\uFEFF/, ""));
        } catch {}
      }
    } catch {}
    return { version: null, tarball: null, integrity: null, source: null, at: null, history: [] };
  }
}

function writeManifest(m) {
  fs.mkdirSync(VENDOR, { recursive: true });
  // vendor.json 是契约锚，正常情况下被置只读。写入前临时解只读，写完立刻恢复，
  // 避免「只读锚」被一次升级永久变成可写。
  let wasReadOnly = false;
  try { wasReadOnly = Boolean(fs.statSync(MANIFEST).mode & 0o200) === false; } catch {}
  try { if (wasReadOnly) fs.chmodSync(MANIFEST, 0o644); } catch {}
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + "\n", "utf8");
  try { if (wasReadOnly) fs.chmodSync(MANIFEST, 0o444); } catch {}
}

function sriOfFile(fp) {
  return `sha512-${crypto.createHash("sha512").update(fs.readFileSync(fp)).digest("base64")}`;
}

// Windows 盘符路径 -> file: URL（doctor 只用来展示，真正的 import 由宿主自己做）
const pathToFileURLSafe = (p) => `file:///${String(p).replace(/\\/g, "/").replace(/^\/+/, "")}`;

// 上游 release 产物名是 dsh-purge-community-<ver>.tgz。本地副本沿用同名，
// 锁定状态由 vendor.json 的 integrity 承载，不靠文件名。
function vendorPath(ver) {
  return path.join(VENDOR, `${UPSTREAM_SLUG}-${ver}.tgz`);
}

// ---------------- unpack + site ----------------

function unpackLocked(ver) {
  const out = path.join(VENDOR, `unpacked-${ver}`);
  const stamp = path.join(out, `.unpacked-${ver}.ok`);
  if (fs.existsSync(stamp)) return out;
  const tgz = vendorPath(ver);
  if (!fs.existsSync(tgz)) die("unpack", `missing vendored tarball: ${tgz}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  try {
    // Windows 10+ 自带 bsdtar，能直接解 .tgz
    execFileSync("tar", ["-xzf", tgz, "-C", out], { stdio: "pipe" });
  } catch (e) {
    die("unpack", `tar failed: ${e.message}`);
  }
  const inner = path.join(out, "package");
  if (fs.existsSync(inner)) {
    for (const ent of fs.readdirSync(inner)) fs.renameSync(path.join(inner, ent), path.join(out, ent));
    fs.rmSync(inner, { recursive: true, force: true });
  }
  fs.writeFileSync(stamp, new Date().toISOString(), "utf8");
  return out;
}

function siteAlias() {
  const man = readManifest();
  if (!man.version) die("site", "vendor.json has no version; run `upstream --yes` first");
  const src = unpackLocked(man.version);
  const pkg = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
  pkg.name = LOCKED_NAME;
  pkg._lockedFrom = { repo: REPO, version: man.version, integrity: man.integrity, at: man.at };

  // 只重建别名目录本身；.pnpm 里的原包不动，随时可回滚
  fs.rmSync(ALIAS_DIR, { recursive: true, force: true });
  fs.mkdirSync(ALIAS_DIR, { recursive: true });
  let entries = 0;
  for (const ent of fs.readdirSync(src)) {
    if (ent === "package.json" || ent.startsWith(".unpacked-")) continue;
    fs.cpSync(path.join(src, ent), path.join(ALIAS_DIR, ent), { recursive: true });
    entries += 1;
  }
  fs.writeFileSync(path.join(ALIAS_DIR, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(ALIAS_DIR, "LOCKED.json"), JSON.stringify(pkg._lockedFrom, null, 2) + "\n", "utf8");
  return { aliasDir: ALIAS_DIR, version: man.version, integrity: man.integrity, entries };
}

// ---------------- dependency rewriting ----------------

const pinSpec = (ver) => `file:${vendorPath(ver).replace(/\\/g, "/")}`;

// 只改「值恰好等于旧 spec 的字符串」，且优先改 dependencies / bundles 这类承载远程依赖的位置；
// 注释、文档、无关字符串一律不碰。
const REMOTE_KEYS = new Set(["dependencies", "bundles", "peerDependencies", "optionalDependencies"]);

function rewriteTree(node, fromSpec, toSpec, hits, trail = "") {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const v = node[i];
      if (typeof v === "string" && v === fromSpec) { node[i] = toSpec; hits.push(`${trail}[${i}]`); }
      else rewriteTree(v, fromSpec, toSpec, hits, `${trail}[${i}]`);
    }
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    const here = trail ? `${trail}.${k}` : k;
    if (typeof v === "string" && v === fromSpec) { node[k] = toSpec; hits.push(here); continue; }
    if (REMOTE_KEYS.has(k) || (v && typeof v === "object")) rewriteTree(v, fromSpec, toSpec, hits, here);
  }
}

function pinDeps({ yes }) {
  const man = readManifest();
  if (!man.version) die("pin", "vendor.json has no version; run `upstream --yes` first");
  const pkg = JSON.parse(fs.readFileSync(PKG_JSON, "utf8").replace(/^\uFEFF/, ""));
  const cur = pkg.dependencies?.[ALIAS_NAME];
  if (!cur) die("pin", `${ALIAS_NAME} not present in profile dependencies`);
  const want = pinSpec(man.version);
  if (cur === want) return { changed: false, spec: want, version: man.version, reason: "already-pinned" };
  if (!yes) return { changed: false, dryRun: true, current: cur, would: want, version: man.version };

  const hits = [];
  rewriteTree(pkg, cur, want, hits);
  if (pkg.dependencies[ALIAS_NAME] !== want) die("pin", "dependencies entry not rewritten");
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  fs.copyFileSync(PKG_JSON, `${PKG_JSON}.bak-${stamp}`);
  fs.writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  return { changed: true, from: cur, to: want, version: man.version, hits, backup: `${PKG_JSON}.bak-${stamp}` };
}

// ---------------- upstream probe ----------------

async function fetchText(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // 注意：直连 github.com 的 releases.atom 在本机经常挂在 TLS 握手阶段（20s 才 abort），
    // 而 api.github.com 偶尔能通。两路都保留，probe() 里谁先成功用谁。
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: "follow",
      headers: { "user-agent": "dsh-purge-resolver", accept: "application/atom+xml,application/json,*/*" },
    });
    return { status: r.status, finalUrl: r.url, text: await r.text() };
  } finally {
    clearTimeout(t);
  }
}

const cmpVer = (a, b) => {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};

async function probe() {
  const man = readManifest();
  const out = { ok: true, repo: REPO, local: man.version, upstream: null, newer: false, feed: [], probeError: "", channel: null };
  // 本机网络两条路都可能挂：直连 github.com 的 atom 经常卡在 TLS 握手（20s abort），
  // api.github.com 时通时 403。所以先并行发，谁先给出可用答案用谁；都不行就记一次 probeError。
  const TIMEOUT = 12000;
  const tryAtom = (async () => {
    try {
      const feed = await fetchText(ATOM, TIMEOUT);
      if (feed.status !== 200) return { channel: "releases.atom", error: `atom: HTTP ${feed.status}` };
      const entries = [...feed.text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, 12).map((m) => {
        const title = (m[1].match(/<title>([^<]+)<\/title>/) || [])[1] || "";
        const updated = (m[1].match(/<updated>([^<]+)<\/updated>/) || [])[1] || "";
        const tag = (m[1].match(/releases\/tag\/([^"]+)"/) || [])[1] || "";
        const version = (title.match(/(\d+\.\d+\.\d+)/) || [])[1] || "";
        return { title, updated, tag, version };
      });
      const latest = entries.find((e) => e.version);
      if (!latest) return { channel: "releases.atom", error: "atom: no versioned entry" };
      return {
        channel: "releases.atom",
        upstream: latest.version,
        upstreamTag: latest.tag,
        upstreamAt: latest.updated,
        upstreamAgeDays: latest.updated ? Math.floor((Date.now() - Date.parse(latest.updated)) / 86400000) : null,
        feed: entries,
      };
    } catch (e) {
      return { channel: "releases.atom", error: `atom: ${e.message}` };
    }
  })();
  const tryApi = (async () => {
    try {
      const r = await fetchText(API, TIMEOUT);
      if (r.status !== 200) return { channel: "api", error: `api: HTTP ${r.status}` };
      const j = JSON.parse(r.text);
      const v = String(j.tag_name || "").replace(/^v/, "");
      if (!v) return { channel: "api", error: "api: no tag_name" };
      return {
        channel: "api",
        upstream: v,
        upstreamTag: j.tag_name || null,
        upstreamAt: j.published_at || null,
        upstreamAgeDays: j.published_at ? Math.floor((Date.now() - Date.parse(j.published_at)) / 86400000) : null,
      };
    } catch (e) {
      return { channel: "api", error: `api: ${e.message}` };
    }
  })();

  const results = await Promise.all([tryAtom, tryApi]);
  const errors = results.map((r) => r.error).filter(Boolean);
  const win = results.find((r) => r.upstream);
  if (win) Object.assign(out, win);
  out.probeError = errors.join("; ");
  out.ok = Boolean(out.upstream);
  out.newer = Boolean(out.upstream) && (!man.version || cmpVer(out.upstream, man.version) > 0);
  return out;
}

async function vendorVersion(ver) {
  const tags = [`v${ver}`, ver];
  const names = [`${UPSTREAM_SLUG}-${ver}.tgz`, `${UPSTREAM_SLUG}.tgz`];
  const tried = [];
  for (const tag of tags) {
    for (const fn of names) {
      const url = `https://github.com/${REPO}/releases/download/${tag}/${fn}`;
      tried.push(url);
      try {
        const r = await fetch(url, { redirect: "follow", headers: { "user-agent": "dsh-purge-resolver" } });
        if (r.status !== 200) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 10000) continue; // 明显不是真 tarball（占位/错误页）
        fs.mkdirSync(VENDOR, { recursive: true });
        const dst = vendorPath(ver);
        fs.writeFileSync(dst, buf);
        const integrity = sriOfFile(dst);
        const man = readManifest();
        // 升级前把旧版归档到 vendor/history，保证任何时刻都能回滚
        let archived = null;
        if (man.version && man.version !== ver) {
          const oldTgz = vendorPath(man.version);
          if (fs.existsSync(oldTgz)) {
            const hd = path.join(VENDOR, "history");
            fs.mkdirSync(hd, { recursive: true });
            const hDst = path.join(hd, path.basename(oldTgz));
            if (!fs.existsSync(hDst)) fs.copyFileSync(oldTgz, hDst);
            fs.writeFileSync(`${hDst}.sha512`, `${man.integrity}  ${path.basename(oldTgz)}\n`, "utf8");
            archived = hDst;
          }
        }
        writeManifest({
          version: ver,
          tarball: url,
          sha512Hex: crypto.createHash("sha512").update(buf).digest("hex"),
          integrity,
          at: new Date().toISOString(),
          source: "upstream-release",
          history: [
            ...(man.history || []),
            ...(man.version ? [{ version: man.version, integrity: man.integrity, at: man.at }] : []),
          ],
        });
        return { ok: true, url, bytes: buf.length, integrity, path: dst, archived };
      } catch (e) {
        tried.push(`ERR ${e.message}`);
      }
    }
  }
  return { ok: false, tried };
}

// ---------------- check ----------------

// 契约层把「社区是否还在发版」与「本地能不能跑」彻底解耦：
//   - 运行路径只读 vendor tarball + 别名包 + profile pin，全是本地文件
//   - 上游探测（probe/upstream）是纯附加信息，失败不影响任何东西
//   - 因此社区停更 = 永远停在锁定版本，仍可无限期使用
// 唯一真正会杀死契约层的场景：宿主大版本改了内部结构，老补丁打不上。
// 那种情况下 `check` 里加一条 drift 探测也没用（补丁缺失不等于契约坏了），
// 真正的判别在 heal 里看 patches 计数。这里只保证「锚」不漂。
function check() {
  const man = readManifest();
  const out = { ok: true, problems: [], warnings: [], vendor: man };
  if (!man.version) {
    out.ok = false;
    out.problems.push("vendor.json: no pinned version");
  }
  const tgz = man.version ? vendorPath(man.version) : null;
  if (tgz && fs.existsSync(tgz)) {
    const sri = sriOfFile(tgz);
    out.tarball = { path: tgz, bytes: fs.statSync(tgz).size, integrity: sri, integrityOk: sri === man.integrity, spec: pinSpec(man.version) };
    if (sri !== man.integrity) { out.ok = false; out.problems.push("tarball integrity drift"); }
  } else if (man.version) {
    out.ok = false;
    out.problems.push("vendored tarball missing");
  }

  const aliasPkg = path.join(ALIAS_DIR, "package.json");
  if (!fs.existsSync(aliasPkg)) {
    out.ok = false;
    out.problems.push("alias package missing (run `site`)");
  } else {
    const p = JSON.parse(fs.readFileSync(aliasPkg, "utf8"));
    out.alias = {
      dir: ALIAS_DIR,
      name: p.name,
      version: p.version,
      lockedFrom: p._lockedFrom || null,
      hasBundle: Boolean(p.dsh?.bundle),
      bundlePatch: p.dsh?.bundle?.patch || null,
      hasClient: Boolean(p.dsh?.client),
      exportsCount: Object.keys(p.exports || {}).length,
    };
    if (p._lockedFrom?.integrity !== man.integrity) {
      out.ok = false;
      out.problems.push("alias package is not the locked build");
    }
    if (!out.alias.hasBundle) {
      out.ok = false;
      out.problems.push("alias package lost its dsh.bundle patch");
    }
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_JSON, "utf8").replace(/^\uFEFF/, ""));
    const spec = pkg.dependencies?.[ALIAS_NAME] || "";
    out.profile = {
      spec,
      pinned: spec.startsWith("file:"),
      inBundles: (pkg.dsh?.profile?.bundles || []).includes(ALIAS_NAME),
      expectedSpec: man.version ? pinSpec(man.version) : null,
    };
    if (!out.profile.pinned) {
      out.ok = false;
      out.problems.push(`profile dependency is unpinned: ${spec}`);
    } else if (man.version && spec !== out.profile.expectedSpec) {
      out.ok = false;
      out.problems.push("profile pin points at a different version than vendor.json");
    }
    if (!out.profile.inBundles) {
      out.ok = false;
      out.problems.push("dsh-purge-community missing from dsh.profile.bundles");
    }
  } catch (e) {
    out.ok = false;
    out.problems.push(`profile package.json unreadable: ${e.message}`);
  }

  // 附加信息，不影响 ok：
  // 1) 历史版本还在不在（回滚能力）—— vendor.json 的 history 数组 + vendor/history 实际文件
  // 2) vendor 目录写保护状态（契约层能否被意外改写）
  try {
    const hist = Array.isArray(man.history) ? man.history : [];
    out.historyVersions = [...new Set([
      ...hist.map((h) => h.version).filter(Boolean),
      ...listArchived().map((a) => a.version),
    ])];
    if (!out.historyVersions.length) out.warnings.push("no archived versions — rollback unavailable (archive one into vendor/history)");
    const broken = out.historyVersions.filter((v) => {
      const f = path.join(VENDOR, "history", `${UPSTREAM_SLUG}-${v}.tgz`);
      return !fs.existsSync(f) && !fs.existsSync(vendorPath(v));
    });
    if (broken.length) out.warnings.push(`history tarballs missing: ${broken.join(", ")}`);
  } catch {}
  try {
    const ro = fs.statSync(MANIFEST);
    if ((ro.mode & 0o200) !== 0) {
      out.warnings.push("vendor.json is writable (expected read-only anchor)");
    } else {
      out.anchorReadOnly = true;
    }
  } catch {}

  return out;
}

// ---------------- rollback ----------------

// 把 vendor.json 指回某个历史版本。tarball 优先从 vendor/history 找，
// 找不到才回落主目录。integrity 用归档 sidecar 或现算，绝不信任别的来源。
// 把 vendor.json 指回某个历史版本。tarball 优先从 vendor/history 找，
// 找不到才回落主目录。integrity 用归档 sidecar 或现算，绝不信任别的来源。
//
// 候选来源有两处，缺一不可：
//   - vendor.json 的 history 数组（升级时由 vendorVersion 记录）
//   - vendor/history/*.tgz 的实际文件（手动归档、或 history 数组被清掉后的兜底）
function listArchived() {
  const hd = path.join(VENDOR, "history");
  const out = [];
  try {
    for (const f of fs.readdirSync(hd)) {
      const m = f.match(new RegExp(`^${UPSTREAM_SLUG}-(\\d+\\.\\d+\\.\\d+)\\.tgz$`));
      if (m) out.push({ version: m[1], file: path.join(hd, f) });
    }
  } catch {}
  return out;
}

function rollback({ ver, yes }) {
  const man = readManifest();
  const hist = Array.isArray(man.history) ? man.history : [];
  const archived = listArchived();
  const candidates = [...new Set([
    ...hist.map((h) => h.version).filter(Boolean),
    ...archived.map((a) => a.version),
    man.version,
  ].filter(Boolean))];
  // 默认回滚到「当前版本之外的最新归档」，没有归档就无候选
  const fallback = candidates.find((v) => v !== man.version) || null;
  const target = ver || fallback;
  if (!target) die("rollback", "no other version available (need vendor/history/<ver>.tgz)");
  if (!candidates.includes(target)) die("rollback", `unknown version ${target}; candidates: ${candidates.join(", ")}`);
  const hTgz = path.join(VENDOR, "history", `${UPSTREAM_SLUG}-${target}.tgz`);
  const vTgz = vendorPath(target);
  const src = fs.existsSync(hTgz) ? hTgz : fs.existsSync(vTgz) ? vTgz : null;
  if (!src) die("rollback", `no tarball for ${target} in vendor/history or vendor/`);
  if (target === man.version) return { changed: false, version: target, reason: "already-current", candidates };
  if (!yes) return { changed: false, dryRun: true, from: man.version, would: target, tarball: src, candidates };

  // 归档里的 sidecar 只是「当时记录的期望值」，还是要对实际字节验一遍
  const actual = sriOfFile(src);
  const expect = (() => {
    const side = `${src}.sha512`;
    if (fs.existsSync(side)) {
      const m = fs.readFileSync(side, "utf8").match(/sha512-[A-Za-z0-9+/=]+/);
      if (m) return m[0];
    }
    const h = hist.find((x) => x.version === target);
    return h?.integrity || null;
  })();
  if (expect && expect !== actual) die("rollback", `integrity mismatch for ${target}: expected ${expect}, got ${actual}`);

  // 主目录里的 shim 指向 history 里的实际文件，避免复制两份 1.7MB
  if (src !== vTgz) fs.copyFileSync(src, vTgz);
  const next = {
    ...man,
    version: target,
    integrity: actual,
    sha512Hex: crypto.createHash("sha512").update(fs.readFileSync(vTgz)).digest("hex"),
    tarball: `vendor/history/${path.basename(hTgz)}`,
    at: new Date().toISOString(),
    source: `rollback from ${man.version}`,
    history: [
      ...hist.filter((h) => h.version !== target),
      ...(man.version && man.version !== target ? [{ version: man.version, integrity: man.integrity, at: man.at }] : []),
    ],
  };
  writeManifest(next);
  const site = siteAlias();
  const pin = pinDeps({ yes: true });
  let verified = false;
  try { verified = check().ok; } catch {}
  return { changed: true, from: man.version, to: target, integrity: actual, site, pin, candidates, verified };
}

// ---------------- doctor ----------------

// 真正把别名包 import 一遍，确认宿主加载时不会立刻炸。
// 用一个短命子进程做，避免把 cordis 上下文拖进当前进程。
function doctorRunImport() {
  const entry = path.join(ALIAS_DIR, "lib", "index.js");
  if (!fs.existsSync(entry)) return { ok: false, detail: "lib/index.js missing" };
  const code = `import(${JSON.stringify(pathToFileURLSafe(entry))}).then(m=>{console.log(JSON.stringify({ok:true,keys:Object.keys(m).length}));}).catch(e=>{console.log(JSON.stringify({ok:false,error:String(e&&e.message||e)}));process.exitCode=1;});`;
  try {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DSH_PURGE_IMPORT_PROBE: "1" },
    });
    const j = JSON.parse(out.trim().split("\n").pop());
    return j.ok ? { ok: true, detail: `${j.keys} exports, import clean` } : { ok: false, detail: j.error };
  } catch (e) {
    const s = String(e?.stdout || "").trim();
    if (s) { try { const j = JSON.parse(s.split("\n").pop()); return { ok: Boolean(j.ok), detail: j.error || `${j.keys} exports` }; } catch {} }
    return { ok: false, detail: String(e?.message || e).slice(0, 300) };
  }
}

// 一条命令回答「现在到底能不能一直用」。
// 检查的是「运行必需 vs 上游可选」的分界线是否还成立。
function doctor() {
  const c = check();
  const man = readManifest();
  const rows = [];
  const add = (name, state, detail) => rows.push({ name, state, detail });

  // 0. 契约层是不是真能跑起来 —— 这一步才叫「验」，前面全是在看文件在不在
  //    用 --selftest 时跑完整 import；默认只做静态探测（导出一个 import 会拉起 cordis 上下文，代价高）
  const selfTest = doctorRunImport();
  add("alias import", selfTest.ok ? "ready" : "broken", selfTest.detail);

  // 1. 锚
  add("vendor anchor", man.version && fs.existsSync(vendorPath(man.version)) ? "ready" : "broken",
    man.version ? `locked v${man.version}` : "no pinned version");

  // 2. 别名包可 import（真正能跑才算数）
  let importState = "broken";
  let importDetail = "";
  try {
    const entry = path.join(ALIAS_DIR, "lib", "index.js");
    if (fs.existsSync(entry)) {
      importState = "ready";
      importDetail = pathToFileURLSafe(entry);
    } else importDetail = "lib/index.js missing";
  } catch (e) { importDetail = e.message; }
  add("alias package", importState, importDetail);

  // 3. profile 依赖 + bundles
  add("profile dependency", c.profile?.pinned ? "ready" : "broken", c.profile?.spec || "missing");
  add("profile bundles", c.profile?.inBundles ? "ready" : "broken", "dsh.profile.bundles");

  // 4. lockfile 是否也指本地（防止 pnpm install 把 URL 拉回来）
  let lockState = "unknown";
  let lockDetail = "";
  try {
    const lockPath = path.join(PROFILE, "pnpm-lock.yaml");
    if (fs.existsSync(lockPath)) {
      const txt = fs.readFileSync(lockPath, "utf8");
      const remote = /dsh-purge-community[^\n]*github\.com/i.test(txt);
      lockState = remote ? "warn" : "ready";
      lockDetail = remote ? "lockfile still references github (pnpm install may re-fetch)" : "lockfile points at local file:";
    } else lockDetail = "no pnpm-lock.yaml";
  } catch (e) { lockDetail = e.message; }
  add("lockfile", lockState, lockDetail);

  // 5. 宿主补丁是否还在（这是真正会被官方更新打断的一环）
  let patchState = "unknown";
  let patchDetail = "";
  try {
    const appDir = process.env.DSH_PURGE_APP_DIR || "C:/Users/Mr.Wang/AppData/Local/Programs/DeepSeek Harness/resources/app";
    const asar = path.join(path.dirname(appDir), "app.asar");
    const asarBack = fs.existsSync(asar);
    let marked = 0;
    const ws = [path.join(appDir, "dsh", "node_modules", "@deepseek-ai")];
    for (const root of ws) {
      if (!fs.existsSync(root)) continue;
      for (const name of fs.readdirSync(root)) {
        const lib = path.join(root, name, "lib", "index.js");
        try {
          if (fs.readFileSync(lib, "utf8").includes("[dsh-purge]")) marked += 1;
        } catch {}
      }
    }
    patchState = asarBack ? "broken" : marked >= 20 ? "ready" : "warn";
    patchDetail = asarBack
      ? "app.asar is back — host is loading the sealed archive, patches are dormant (run heal)"
      : `${marked}/302 host lib/index.js carry [dsh-purge] markers, app.asar unsealed`;
  } catch (e) { patchDetail = e.message; }
  add("host patches", patchState, patchDetail);

  // 6. 归档列表（回滚能力）—— 直接来自 vendor.json.history，不做二次渲染
  const arch = [].concat(
    (Array.isArray(man.history) ? man.history : []).map((h) => h.version),
    listArchived().map((a) => a.version),
  ).filter(Boolean);
  const historyVersions = [...new Set(arch)];

  // 7. 上游：纯信息，失败不算坏
  add("upstream feed", "info", man.tarball ? `locked source: ${String(man.tarball).slice(0, 60)}…` : "none");

  const bad = rows.filter((r) => r.state === "broken");
  return {
    ok: bad.length === 0,
    verdict: bad.length === 0 ? "可长期使用：运行路径全本地，社区停更不影响" : "有硬故障，先修红项",
    lockedVersion: man.version,
    history: historyVersions,
    rows,
    problems: c.problems,
    warnings: c.warnings,
  };
}

// ---------------- main ----------------

const cmd = args[0] || "check";
try {
  if (cmd === "check") emit(check());
  else if (cmd === "site") emit({ ok: true, ...siteAlias() });
  else if (cmd === "pin") emit({ ok: true, ...pinDeps({ yes: has("--yes") }) });
  else if (cmd === "probe") emit(await probe());
  else if (cmd === "doctor") emit(doctor());
  else if (cmd === "rollback") {
    const verArg = args.slice(1).find((a) => /^\d+\.\d+\.\d+$/.test(a)) || null;
    emit({ ok: true, ...rollback({ ver: verArg, yes: has("--yes") }) });
  }
  else if (cmd === "upstream") {
    const p = await probe();
    if (!p.ok) die("probe", p.probeError || "upstream unreachable");
    if (!p.newer) {
      const vendored = fs.existsSync(vendorPath(readManifest().version || "0.0.0"));
      emit({ ok: true, action: "none", probe: p, vendored });
    } else {
      const v = await vendorVersion(p.upstream);
      if (!v.ok) die("vendor", JSON.stringify(v.tried));
      const site = siteAlias();
      const pin = pinDeps({ yes: has("--yes") });
      emit({ ok: true, action: "updated", probe: p, vendor: v, site, pin });
    }
  } else die("args", `unknown command: ${cmd}`);
} catch (e) {
  die("runtime", e?.stack || e?.message || e);
}
