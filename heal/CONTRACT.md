# 破甲长期可用方案 · 契约层

> 一句话：**把「社区还发不发新版」从运行路径里彻底摘出去。** 运行只读本地文件，探测上游纯属附加信息。

## 一、为什么原来会断

原依赖写的是：

```
dsh-purge-community: https://github.com/kingcharleslzy-ai/dsh-purge/releases/latest/download/dsh-purge-community.tgz
```

这条链有三个断点：

| 断点 | 后果 |
|---|---|
| `/releases/latest/` 是**动态**的 | 上游一删 release / 改 tag 名，URL 直接 404 |
| `pnpm install` 会**重新联网** | 官方更新后自动重装依赖 → 必然重新拉 → 断 |
| 只有网络可用时才能装 | 断网/被墙/仓库归档 → 装不上，整层破甲消失 |

## 二、现在的结构

```
C:\Users\Mr.Wang\.dsh\dsh-purge\
├─ vendor\
│   ├─ dsh-purge-community-1.6.60.tgz      ← 主锚（1,776,217 B）
│   ├─ vendor.json                          ← 只读清单（IsReadOnly=true）
│   └─ history\
│       └─ dsh-purge-community-1.6.60.tgz  ← 归档副本 + .sha512 sidecar
└─ heal\
    ├─ resolver.mjs    ← 七命令：check / site / pin / probe / upstream / doctor / rollback
    ├─ heal.ps1        ← 每 10 分钟：asar 回来了就重建宿主；没回来就校验契约层并自修
    ├─ upstream.ps1    ← 每 12 小时：只探测，从不自动升级
    └─ self-check.mjs  ← 每 6 小时：含 checkContract()

C:\Users\Mr.Wang\.dsh\profiles\desktop\
├─ package.json      → dsh-purge-community: file:C:/Users/Mr.Wang/.dsh/dsh-purge/vendor/dsh-purge-community-1.6.60.tgz
├─ pnpm-lock.yaml    → 三处也全是 file: 路径（L23-25 / L419-420 / L1380）
└─ node_modules\dsh-purge-community\   ← 别名包（实目录），name=dsh-purge-community-locked
```

**关键点**：`node_modules\dsh-purge-community` 不是符号链接，是**实体目录**。它由 `resolver site` 从 vendor tarball 解包重建，
package.json 里 name 改成 `dsh-purge-community-locked`、写 `_lockedFrom{repo,version,integrity,at}`，旁边有 `LOCKED.json`。
宿主按 `dsh.profile.bundles` + 包的 `dsh.bundle.patch` 加载它 —— 全程不读网络。

## 三、日常用法

```powershell
$n = 'C:\Users\Mr.Wang\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$r = 'C:\Users\Mr.Wang\.dsh\dsh-purge\heal\resolver.mjs'

& $n $r doctor      # ← 只想知道「现在能不能一直用」就跑这个
& $n $r check       # 机器可读体检
& $n $r probe       # 上游还有没有新版（并行 atom + api，12s 超时）
& $n $r rollback    # 回滚到上一个归档版本（dry-run；加 --yes 真做）
```

`doctor` 输出长这样（8 项全绿 / 1 项可选提示）：

| 判定项 | 含义 |
|---|---|
| `alias import` | 真跑子进程 `import()` 别名包，能出 9 个导出才算过 |
| `vendor anchor` | vendor tarball 在位、sha512 对得上 |
| `alias package` | 别名包 name/version/_lockedFrom 是锁定版 |
| `profile dependency` | package.json 里的 spec 是 `file:` 而不是 `https://` |
| `profile bundles` | `dsh.profile.bundles` 里有它 |
| `lockfile` | pnpm-lock.yaml 没有 GitHub URL |
| `host patches` | `resources/app` 已解包、26 个包的 lib/index.js 带 `[dsh-purge]` |
| `upstream feed` | 纯信息（上游地址），失败不算坏 |

## 四、三种故障怎么自己好

### 1. 官方更新把 asar 装回来了
`heal.ps1`（每 10 分钟）检测到 `resources\app.asar` 存在 → 等宿主退出 → `apply.mjs` 重新解包 + 重打补丁 → asar 改名 `.bak`。
**这之后还会跑一遍 `resolver check`**，因为解包可能把别名包覆盖回官方内容。

### 2. 有人跑了 `pnpm install` 把依赖拉回 GitHub
`resolver check` 看到 `profile dependency is unpinned: https://github.com/...` → `heal.ps1` 自动 `site`（重放别名包）+ `pin`（改回 file:）+ 复验。**实测通过**。

### 3. 新版破甲打不上老宿主（宿主大版本变了）
这跟社区停更无关，是「宿主内部结构 vs 破甲补丁点」的对抗。判别看 `self-check` 的 `patch-tally`：
- `72/80 applied` = 正常
- 数字掉到 60 以下 = 有补丁找不到锚点，要去 `patch-80` 那条看具体是哪条

处置：`resolver rollback` 回到上一个能打的版本，等上游适配。只要 vendor 里存着旧 tarball，这一步永远可做。

## 五、上游还活着时怎么升级（手动、可控）

```powershell
powershell -File upstream.ps1 -Apply
```

等价于 `resolver upstream --yes`：probe → 有新版才 `vendorVersion()`（顺手把旧版归档进 `vendor\history\` + 写 sidecar）→ `site` → `pin`。

**绝不自动升级**的原因：破甲打的是宿主内部文件，升级是高风险动作；探测是零风险，所以只自动探测。

## 六、这个方案的上限在哪

| 场景 | 能不能一直用 |
|---|---|
| 社区停更，永远停在 1.6.60 | ✅ 能。运行路径零网络依赖 |
| 仓库删库 / release 404 | ✅ 能。vendor 已有本地副本 |
| 断网 / 被墙 | ✅ 能。`site`/`pin` 全本地 |
| 有人误跑 `pnpm install` | ✅ 能。heal 每 10 分钟自动修回 |
| 宿主小版本更新（0.2.1-rc.x → rc.y） | ✅ 大概率能。补丁锚点通常没动 |
| 宿主**大版本**重构内部结构 | ⚠️ 补丁会掉。契约层保不住这个 —— 得等上游适配或自己改补丁点 |
| 硬盘上 vendor 目录被删 | ❌ 就真没了。这就是为什么要归档到两处（主 + history） |

最后一行是唯一的单点。想要更狠：把 `vendor\dsh-purge-community-1.6.60.tgz` 再拷一份到别的盘/U 盘/网盘 —— 1.7MB 而已。
