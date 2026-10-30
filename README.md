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
├── .gitattributes            `* -text`：关掉换行符转换，保证逐字节一致
├── restore.ps1               **一键重建入口**（干跑用 -WhatIfLike）
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
├── config/                   要落到 $DSH_HOME 的配置原件
│   ├── cordis.patch.yml      L3 运行时权限 + 插件装配 + 全部模型定义
│   ├── package.json          profile 依赖清单（pin 由 restore.ps1 重写）
│   └── startup/
│       └── dsh-purge-heal.vbs.tpl   登录启动器模板，纯 ASCII
├── install/
│   └── register-tasks.ps1    重建三个计划任务 + 启动项
├── heal/                     自愈与验证工具（核心）
├── tools/                    维护脚本（push.ps1 等）
└── vendor/                   上游包离线锚
    ├── dsh-purge-community-1.6.60.tgz
    ├── vendor.json           integrity 清单（只读锚）
    └── history/              历史版本归档 + .sha512 sidecar
```

### 什么入库、什么不入库

入库的是**结构性配置**：补丁清单、基线指纹、契约锚、工具、要落到 `$DSH_HOME` 的原件。

不入库的有三类：

| 类别 | 文件 | 理由 |
|---|---|---|
| 运行时状态 | `heal/heal-verdict.json`、`heal/self-check-latest.json`、`heal/upstream-report.json` | 计划任务每 6~12 小时重写，入库只制造噪音 diff |
| 机密 | `gui-session.json`、`gui-token.json`、`gui-helper.*`、`last-gui-baseurl.txt` | 含实时 cookie 和 launch token |
| 大体积中间产物 | `vendor/unpacked-*/`（4.15 MB）、`*.bak*` | 可用 `resolver.mjs site` 从 tarball 本地重放 |

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

### 结论先说：**克隆下来不能直接用，要跑一次 `restore.ps1`**

这个仓库是**配置快照 + 重建工具**，不是可执行安装包。原因：

| 缺什么 | 为什么仓库里没有 | 怎么补 |
|---|---|---|
| `node_modules`（1.1 GB） | 体积太大，且 pnpm 可重建 | `restore.ps1` 自动 pnpm install |
| `resources\app` 里 54 个被打补丁的文件 | 属于宿主安装目录，不是配置 | `heal.ps1` 从 asar 解包后重放 |
| 计划任务 / 启动项 | 存在系统里，不在文件系统 | `install\register-tasks.ps1` 重建 |
| `.credentials.yaml` | **凭据，永不入库** | 手工在 Models 页重新填 key |
| `sessions` / `AGENTS.md` | 会话与个人记忆 | 自己搬或重写 |

### 一条命令

```powershell
# 前置：装好同版本 DSH，并启动一次再退出（生成 $DSH_HOME 和默认 profile）
git clone git@github.com:huapingwang63-cmyk/dsh-purge-local.git
cd dsh-purge-local
pwsh -File restore.ps1 -WhatIfLike      # 先干跑，看它要动哪些文件
pwsh -File restore.ps1                  # 真跑
```

`restore.ps1` 做 7 件事，**每步覆盖前都先备份成 `.bak-<时间戳>`**，幂等，可重复跑：

1. `prompt-inject.md` → `$DSH_HOME\`（L1 本体，缺了它破甲只剩一半）
2. 11 个状态文件 → `$DSH_HOME\dsh-purge\`（按**显式白名单**，不用通配，避免把 `restore.ps1` 自己拷进去）
3. `heal\` + `vendor\` → `$DSH_HOME\dsh-purge\`
4. `config\cordis.patch.yml` → `profiles\desktop\`（L3 权限）
5. `config\package.json` → `profiles\desktop\`，并把 `dsh-purge-community` 的 pin **重写成当前机器的绝对路径**
6. `pnpm install`（`-SkipPnpm` 跳过）
7. `install\register-tasks.ps1`（`-SkipTasks` 跳过）

跑完它会把下一步交给你，因为**重放补丁必须先关掉 DSH**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\dsh-purge\heal\heal.ps1" -Wait -Start
```

`heal.ps1` 会：检测 `app.asar` 存在 → 等宿主退出 → 调 `apply.mjs`
→ 从 asar 解包到 `resources\app` → 重打 80 条补丁 → 6 份 pi-ai 白名单
→ 把 asar 改名 `.bak` → 重新启动。

### 为什么 `node_modules` 和 lockfile 都不是可选项

实测过：**在这个 profile 上 `pnpm install` 无法从零复现**，不要指望它。

```
$ pnpm install            # 没有 lockfile 时
ERR_PNPM_NO_MATCHING_VERSION  No matching version found for
  @deepseek-ai/dsh-client-ui-slots@>=0.2.1 <0.3.0-0

The latest release of @deepseek-ai/dsh-client-ui-slots is "0.0.1-rc.1". Published 2026/8/11
Other releases are: alpha: 0.2.2-alpha.2  next: 0.2.1-rc.5
```

上游把可用版本全挂在 `next` / `alpha` dist-tag 上，registry 的 `latest` 停在
`0.0.1-rc.1`。所以只要 pnpm 需要**重新解析整张依赖图**，就必然失败。

加了 lockfile 也还不够 —— 还必须把 settings 对齐，否则报
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH (settings.autoInstallPeers)`；
再对齐之后还会报 `ERR_PNPM_OUTDATED_LOCKFILE`，因为本机 lockfile 本来就比
package.json 旧（`dsh-our-free-model@2.1.0`、`dsh-better-sidebar@0.28.1` 后加的没进 lockfile）。

结论：

1. **`config/pnpm-lock.yaml` 必须入库**（55.8 KB，1773 行）—— 已入
2. **`restore.ps1` 默认跳过 install**：只要 `node_modules` 已在就直接用，
   要重装必须显式 `-ForceInstall`，那时走 `--frozen-lockfile` 并显式对齐 settings
3. **跨机迁移最可靠的做法是整目录搬 `profiles\desktop`（含 node_modules）**，
   而不是重新装依赖。1.1 GB，但一次就成

本机把 `dsh-lang-zh`（唯一的 `git+https` 依赖）也打成了 vendor tarball：

```
vendor/dsh-lang-zh-1.0.0.tgz      3493 B   sha512-aGlPopRl9sH5r/gaTefRqBnsyDiM1u3v2YR3tdQVttmnWYcF07CVVS4F3WR/fTZNr4bu+EwpYgSmGCa0EUGlvg==
vendor/dsh-purge-community-1.6.60.tgz   sha512-4Kly9aRE0hzbRkPBy/6dmZUYm0uc7JXtEP7oa2jiShahLuu/E/8z6lpCeLp1T0/Yf+2LEY6f65lk6DQreeexGg==
```

两个锚的清单与来源说明在 `vendor/anchors.json`，`restore.ps1` 把这两条依赖都改写成
`file:` 绝对路径，这样装依赖时**不需要访问 GitHub**。

### 校验

```powershell
$n = "<安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $n "$env:USERPROFILE\.dsh\dsh-purge\heal\self-check.mjs"
& $n "$env:USERPROFILE\.dsh\dsh-purge\heal\resolver.mjs" doctor
```

`self-check` 是 37 项（实测 40 ok / 2 warn / 0 fail 为健康），
`doctor` 是 8 项判定，全绿才算通。

### 如果 pin 被 pnpm 装回 GitHub 地址

`profiles\desktop\package.json` 里 `dsh-purge-community` 必须是**本地 file: pin**：

```json
"dsh-purge-community": "file:C:/Users/<你>/.dsh/dsh-purge/vendor/dsh-purge-community-1.6.60.tgz"
```

漂了就手动拉回：

```powershell
& $n "$env:USERPROFILE\.dsh\dsh-purge\heal\resolver.mjs" site
& $n "$env:USERPROFILE\.dsh\dsh-purge\heal\resolver.mjs" pin --yes
```

### 计划任务 / 启动项

```powershell
pwsh -File install\register-tasks.ps1            # 建三个任务 + 启动 vbs
pwsh -File install\register-tasks.ps1 -DryRun    # 只看不建
pwsh -File install\register-tasks.ps1 -Remove    # 全删
pwsh -File install\register-tasks.ps1 -Suffix -TEST   # 建 xxx-TEST 用于验证，用完 -Remove
```

| 任务 | 周期 | 干什么 |
|---|---|---|
| `DSH Purge Heal` | 10 分钟 | asar 回来了就重新解包打补丁 |
| `DSH Purge Upstream` | 12 小时 | 只探测上游有没有新版，**从不自动升级** |
| `DSH Self Check` | 6 小时 | 37 项自检，写 verdict json |

> 坑：`schtasks /create` **不要**加 `/ru` / `/rp`。加了会变成「不管用户是否登录都运行」，
> 要存密码、要管理员权限。不加才会是 `LogonType=InteractiveToken`，和现在能跑的那三个一致。
> 同理 `ONLOGON` 触发器要管理员，所以登录启动用启动文件夹里的 `.vbs` 代替。

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

## 怎么往回推

### 首选：SSH（已配好，不需要任何 token）

remote 现在是 `git@github.com:huapingwang63-cmyk/dsh-purge-local.git`，直接 `git push` 即可：

```powershell
git push                      # 推 committed 的内容
git push origin <tag>         # 推标签
```

依赖的密钥：

| 项 | 值 |
|---|---|
| 私钥 | `~/.ssh/id_ed25519_personal`（**无密码**） |
| 公钥 | `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHUzaYmVzB5W2IcRDkEnPdE8MA5RnQTrNU2+ydXkiMJA huapingwang63@gmail.com` |
| 指纹 | `SHA256:E+g7L6Tm8/MO2bbUxRA/MnA1MXeWBPMRniaGsFVjvAo` |
| 账号 | `huapingwang63-cmyk` |

> **造密钥的坑**：`ssh-keygen -N '""'` 在 PowerShell 里 `""` 会当**两个引号字符**传进去，
> 结果是「带密码的密钥」，`BatchMode=yes` 下表现为
> `Server accepts key: ...` 紧跟 `Permission denied (publickey)`。
> 正确写法：`cmd /c 'ssh-keygen -t ed25519 -C "mail" -f KEY -N ""'`。

旧 RSA 密钥（注释含公司邮箱）已挪到 `~/.ssh/backup-20261031/`，
`~/.ssh/config` 里留了 `Host github-rsa` 别名做回退：

```powershell
git remote set-url origin git@github-rsa:huapingwang63-cmyk/dsh-purge-local.git
```

### 兜底：HTTPS + PAT（`tools/push.ps1`）

SSH 走不通时才用。这台机器上 `git push` 走 HTTPS 有三个独立的坑叠在一起：

1. **全局 `url.insteadOf` 把 github.com 改写成 `gh-proxy.com/https://github.com/`**
   —— 那个镜像只服务公开只读流量，带鉴权的 push 必然失败
2. **直连 443 到 github.com 时通时断**（`Connection was reset` / `Could not connect after 21s`）
   —— 必须显式指定本地代理，走系统代理设置 git 不认
3. **token 绝不能写进 `.git/config`**

`tools/push.ps1` 一次解决三条：用临时 `GIT_CONFIG_GLOBAL` 屏蔽重写、`-c http.proxy` 走代理、
token 只作为一次性 `http.extraheader` 出现。

```powershell
$env:GITHUB_TOKEN = 'ghp_xxx'          # 需要 repo scope
pwsh -File tools\push.ps1
# 或
pwsh -File tools\push.ps1 -Token ghp_xxx -Proxy http://127.0.0.1:7890
```

脚本结束会删临时配置并清环境变量，token 不会留在磁盘上。push 前会先
`git config --get http.https://github.com/.extraheader` 自检，区分「鉴权挂了」和「参数没传进去」。

> 用 HTTPS 兜底后记得把 remote 改回 SSH，不然下次又踩坑 1 和 2。

---

## 上游与许可


`vendor/dsh-purge-community-1.6.60.tgz` 来自
[kingcharleslzy-ai/dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge)，MIT。
本仓库仅为**本机配置备份**，vendored tarball 原样保留未做修改，
`vendor/vendor.json` 记录了 integrity 供校验。
