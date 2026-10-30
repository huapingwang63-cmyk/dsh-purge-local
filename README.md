# dsh-purge-local

DeepSeek Harness（DSH）桌面端的**本机破甲配置备份**与**离线重建工具集**。

不是插件源码仓库，而是把一台机器上已经调通的三层破甲配置冻结成可迁移的资产：
换机、重装、官方更新冲掉补丁时，从这里恢复。

---

## 目录结构

```
.
├── README.md                 本文件
├── .gitignore
├── prompt-inject.md          L1 提示词注入本体（25128 字节，226 行）
├── applied.json              已应用的补丁清单
├── expected-baseline.json    官方基线指纹（判断宿主是否被改过）
├── installed-rev             当前安装版本标记  apply:1.6.60
├── override-state.json       提示词覆盖状态与哈希
├── passthrough.json          sealed-inprocess 模式标记
├── drill-grant.json          演练授权标记
├── tuning.json               调参快照
├── update-status.json        官方更新状态
├── settle-restart.guard      重启守护标记
├── unpacked-asar.json        asar 解包指纹（size + mtimeMs）
├── unseal-on-quit.ps1        退出时解封脚本
├── heal/                     自愈与验证工具（核心）
├── tools/                    维护脚本（push.ps1 等）
└── vendor/                   上游包离线锚
    ├── dsh-purge-community-1.6.60.tgz
    ├── vendor.json           integrity 清单（只读锚）
    └── history/              历史版本归档 + .sha512 sidecar
```

---

## 三层结构

| 层 | 内容 | 落点 |
|---|---|---|
| **L1 提示词注入** | `prompt-inject.md`（约 25 KB），每轮以 `tail` 位置注入，官方基线被丢弃 | `$DSH_HOME\prompt-inject.md` |
| **L2 宿主代码补丁** | 72 条补丁命中 54 个文件，文件头带 `[dsh-purge]` 标记 | `<安装目录>\resources\app\` |
| **L3 运行时权限** | `permission-presets.defaultPreset: danger-full-access`、`approval: never` | `$DSH_HOME\profiles\desktop\cordis.patch.yml` |

> **关键**：Electron 优先读 `app.asar`，其次才读 `resources\app\` 目录。
> 所以 L2 生效的前提是 **asar 必须被移走/改名**，否则解包目录形同虚设。

---

## 换一台机器怎么恢复

### 0. 前置

- 装好同版本 DSH，**先启动一次再退出**（生成 `$DSH_HOME` 与默认 profile）
- 自带 node 路径（用于跑 `.mjs`）：
  ```
  <安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
  ```

### 1. 铺回配置

```powershell
$src = "D:\DSH工作台\dsh-purge-local"
$dsh = "$env:USERPROFILE\.dsh"

# L1 提示词注入本体 —— 缺了它破甲只剩一半
Copy-Item "$src\prompt-inject.md" $dsh -Force

# 状态文件
Copy-Item "$src\*.json","$src\installed-rev","$src\unseal-on-quit.ps1" $dsh -Force

# 工具集
New-Item -ItemType Directory "$dsh\dsh-purge" -Force | Out-Null
Copy-Item "$src\heal"   "$dsh\dsh-purge\" -Recurse -Force
Copy-Item "$src\vendor" "$dsh\dsh-purge\" -Recurse -Force
```

> `prompt-inject.md` 必须落在 `$DSH_HOME` 根目录（默认 `C:\Users\<你>\.dsh\prompt-inject.md`）。
> 生效条件是 profile 的 `cordis.patch.yml` 里 `injectPosition: tail` 且官方基线被丢弃 ——
> 检查办法：改一个字，重开一轮，看它是否出现在系统提示尾部。

### 2. 重放宿主补丁（L2）

```powershell
& "$env:USERPROFILE\.dsh\dsh-purge\heal\heal.ps1" -Wait -Start
```

`heal.ps1` 会：检测 `app.asar` 存在 → 等宿主退出 → 调 `apply.mjs`
→ 从 asar 解包到 `resources\app` → 重打 80 条补丁 → 6 份 pi-ai 白名单
→ 把 asar 改名 `.bak` → 重新启动。

### 3. 校验

```powershell
$n = "<安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $n "$env:USERPROFILE\.dsh\dsh-purge\heal\self-check.mjs"
& $n "$env:USERPROFILE\.dsh\dsh-purge\heal\resolver.mjs" doctor
```

`doctor` 输出 8 项判定，全绿才算通。

### 4. 恢复 plan 依赖

`profiles\desktop\package.json` 里 `dsh-purge-community` 必须是**本地 file: pin**：

```json
"dsh-purge-community": "file:C:/Users/<你>/.dsh/dsh-purge/vendor/dsh-purge-community-1.6.60.tgz"
```

改完执行：

```powershell
& $n "$env:USERPROFILE\.dsh\dsh-purge\heal\resolver.mjs" site
& $n "$env:USERPROFILE\.dsh\dsh-purge\heal\resolver.mjs" pin --yes
```

---

## heal/ 工具速查

| 脚本 | 作用 |
|---|---|
| `heal.ps1` | **总入口**。`-Wait` 等宿主退出，`-Start` 完成后启动，`-Quiet` 只记录结果 |
| `apply.mjs` | 解包 asar → 重打 80 条补丁 → 移走 asar |
| `resolver.mjs` | 契约层。`check` / `site` / `pin` / `probe` / `upstream` / `doctor` / `rollback` |
| `self-check.mjs` | 37 项自检，覆盖补丁计数、注入、契约、计划任务 |
| `self-check.ps1` | 上者的 PS 包装，`-Quiet` 只落 verdict |
| `upstream.ps1` | 只探测不升级，写 `upstream-report.json`，永远 exit 0；`-Apply` 才真升级 |
| `dsh-gui.mjs` | 起 `dsh web` helper 并铸造鉴权 cookie，`--json` / `--stop` / `--status` |
| `gui-playwright.mjs` | 输出 Playwright 可直接用的 `baseUrl` / `launchUrl` / `cookie` |
| `gui-cookie.mjs` | cookie 伪造器，`--selftest` / `--live` |
| `probe-mcp.mjs` | MCP stdio 探针，验证 browser server 45 工具 |
| `dsh-memory-hook.mjs` | 会话记忆钩子，挂 `workspace/session-stop` |
| `sim-memory-hook.mjs` | 上者的离线端到端模拟 |
| `payload-diff.mjs` / `final-verify.mjs` / `e2e-proof.mjs` / `control-test.mjs` | 见证与回归证据 |

---

## 计划任务（自愈三道）

| 任务 | 周期 | 作用 |
|---|---|---|
| `DSH Purge Heal` | 10 分钟 | 检测 asar 被官方更新装回 → 自动重放补丁 |
| `DSH Purge Upstream` | 12 小时 | 只 probe 上游版本，不改动任何东西 |
| `DSH Self Check` | 6 小时 | 37 项自检 |

外加启动目录的 `dsh-purge-heal.vbs`（登录时触发），弥补 ONLOGON 计划任务需要管理员权限的问题。

**注册示例**（路径按实际改）：

```powershell
schtasks /Create /TN "DSH Purge Heal" /SC MINUTE /MO 10 /F `
  /TR "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"C:\Users\<你>\.dsh\dsh-purge\heal\heal.ps1\" -Quiet"
```

---

## 踩过的坑（写下来省时间）

1. **`ssh-keygen -N '""'` 会造出带密码的密钥**。PowerShell 把 `""` 当字面两字符传进去。
   正确写法：`cmd /c 'ssh-keygen -t ed25519 -C "mail" -f KEY -N ""'`。
   症状：`BatchMode=yes` 下报 `Server accepts key` 紧跟 `Permission denied (publickey)`。
2. **`cordis.patch.yml` 新增插件必须用 `insert:` 包裹**。裸 `- id: xxx` 是按 id 修改已有条目，
   命中不了会 `warn(... not found)` 并**静默跳过**。
3. **cookie 的 HMAC key 要先 base64url 解码成原始 Buffer**，直接拿字符串当 utf8 key 会签名全错。
4. **cookie 严格绑定 authority 字符串**：`localhost:x` 会 401，必须 `127.0.0.1:x`。
5. **分离进程要 `stdio:["ignore",fd,fd]` + `detached:true`**，`child.unref()` 不够。
   stdout 必须落文件，因为真实端口只在 launch URL 里。
6. **`[System.IO.File]::WriteAllLines` 在 PS 5.1 会把字符串数组压成单行**，写出的脚本静默失效。
7. **PS 5.1 用 `& $exe -Command '...'` 调子进程会吞双引号**，验证脚本一律写独立 `.ps1` 用 `-File` 跑。

---

## 稳定性判据

- `self-check` 的 `patch-tally` 与 `patch-80` 两项是**唯一的真实风险指标**：
  宿主大版本改内部结构 → 老补丁打不上 → 这两项掉。
- `resolver doctor` 只管「包还在、能 import、pin 没漂」，跟补丁能否命中是两件事。

---

## 怎么往回推（`tools/push.ps1`）

这台机器上 `git push` 不能直接跑通，三个独立的坑叠在一起：

1. **全局 `url.insteadOf` 把 github.com 改写成 `gh-proxy.com/https://github.com/`**
   —— 那个镜像只服务公开只读流量，带鉴权的 push 必然失败
2. **直连 443 到 github.com 时通时断**（`Connection was reset` / `Could not connect after 21s`）
   —— 必须显式指定本地代理，走系统代理设置 git 不认
3. **token 绝不能写进 `.git/config`**

`tools/push.ps1` 一次解决三条：用临时 `GIT_CONFIG_GLOBAL` 屏蔽重写、`-c http.proxy` 走代理、
token 只作为一次性 `http.extraheader` 出现。

```powershell
$env:GITHUB_TOKEN = 'ghp_xxx'          # 需要 repo scope
powershell -File tools\push.ps1
# 或
powershell -File tools\push.ps1 -Token ghp_xxx -Proxy http://127.0.0.1:7890
```

脚本结束会删临时配置并清环境变量，token 不会留在磁盘上。

---

## 上游与许可

`vendor/dsh-purge-community-1.6.60.tgz` 来自
[kingcharleslzy-ai/dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge)，MIT。
本仓库仅为**本机配置备份**，vendored tarball 原样保留未做修改，
`vendor/vendor.json` 记录了 integrity 供校验。
