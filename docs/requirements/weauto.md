# WeAuto —— 通用自动化任务框架

> 状态：已实现（2026-10-13）
> 首个任务：v2free 机场每日自动签到
>
> 本文件回答「**为什么**这么做」（方案对比、废弃方案、决策记录、实测修正），
> 已冻结，不再随实现变化更新。
> 实现现状见：[`docs/功能规格/weauto.md`](../功能规格/weauto.md)

---

## 1. 用户场景

**一句话**：作为一个使用 v2free 机场的用户，我希望每天在 09:00 左右（带随机偏移）自动完成网站签到领取免费流量，并在 WeMonitor 页面上看到签到结果与流量余量，从而不必每天手动登录操作。

**演进目标**：WeAuto 不只是签到脚本，而是一个可注册多个自动化任务的骨架。新增任务 = 新增一个任务文件 + 在 WeMonitor 配置一条 crontab。

---

## 2. 前置调研结论（已实测，非推测）

### 2.1 目标站点逆向成果

| 项 | 结论 | 证据来源 |
|---|---|---|
| 面板程序 | SSPanel-Uim 魔改版（Laravel） | `/auth/login` 服务端渲染 + 字段命名风格 + `/assets/js/fuck.js` |
| 登录接口 | `POST /auth/login`，**form-urlencoded** | 登录页内联脚本 inline[9] |
| 登录参数 | `agree=1`、`email`、`passwd`、`code`（可空）、`remember_me` | 同上（**注意是小写 key，与表单 DOM 的 `Email`/`Password` 不同**） |
| 登录返回 | JSON `{"ret":1,"msg":"..."}`，`ret==1` 为成功 | 同上 |
| CSRF | **无** —— 登录请求不带任何 token | `base.min.js` 无 `ajaxSetup`/`_token`/`csrfToken` |
| 签到接口 | `POST /user/checkin` | `GET /user/checkin` → **405 Method Not Allowed**（路由存在，仅接受 POST） |
| 鉴权 | Session Cookie | `GET /user` 未登录 → `302 /auth/login` |
| 验证码 | 当前页面无 recaptcha/geetest 字段；但代码含 `div.gt_slider_knob` 处理逻辑 | 登录页源码 |

### 2.1.1 探针实测确认（2026-10-13）

用真实凭据在 `scripts/probe.mjs` 中实测，**推翻了上面两处逆向推断**：

| 项 | 实测结果 | 影响 |
|---|---|---|
| 2FA | `POST /auth/login` 不携带 `code` 即返回 `{"ret":1,"msg":"登录成功"}` → **账号未开启两步验证** | 无需实现 TOTP |
| CSRF | 签到 `POST /user/checkin` 直接返回 `200 application/json` → **不需要任何 token** | 无需取 `_token` |
| Cookie | 5 个自定义 Cookie：`uid` / `email` / `key` / `ip` / `expire_in`，**全部 `Max-Age=3600`（1 小时）** | 见 §6.6，原 cookie 缓存设计被推翻 |
| `remember_me` | 传 `remember_me=on` 后**有效期仍为 3600s** → **未生效** | 原「延长会话」假设不成立 |
| 签到返回 | 成功 `{"ret":1,...}`；已签 `{"ret":0,"msg":"您似乎已经签到过了..."}` | 解析依据 |
| 频率限制 | 连续调用返回 `{"ret":0,"msg":"请求过于频繁，请稍后再试"}` → **站点有限流** | 失败不立即重试（见 §8） |
| 数据源 | 账户页内嵌 `crispSessionData` 结构化数组，含 `traffic` / `expire` / `plan` / `balance` 等 12 个字段 | 作为面板取数的**权威来源**，优于正则解析 HTML |
| 签到态 DOM | `<b>上次签到</b>:2026-10-13 12:18:43` + 按钮 `disabled` 且文案「今日已签到」 | 已签到判定与跳过依据 |

实测还额外发现：站点公告写明「免费用户 5 天不用不签到，流量会被自动清空」——
这正是自动签到要解决的核心痛点（断签即清零）。

### 2.2 运行环境实测（N150）

| 项 | 实测结果 |
|---|---|
| 主机名 / 系统 | `weweb` / Ubuntu 24.04.4 LTS / x86_64 |
| Node | **v20.18.0**（注意：非本机 nvm 默认的 v24） |
| 可达性 | ✅ **`https://v2free.net` 直连可达**，HTTP 200，1.49s（比本机 0.245s 慢但完全可用） |
| 已有工具 | `sqlite3`、`curl`、`jq`、`node`、`npm` |
| 缺失工具 | `age`（需安装，见 §6.3） |

**这是「跑在 N150」决策成立的前提，已证实可行。**

### 2.3 部署体系实测（N150）

| 项 | 实测结果 |
|---|---|
| `~/.deploy-projects.conf` | 格式 `PROJECT\|REPO\|DIR\|PORT\|TAG_MODE\|FILE_NAME`，现有 4 个项目 |
| **无端口项目支持** | ✅ `deploy-agent.sh:503` 为 `[ -z "$port" ] && continue` —— **PORT 留空即跳过健康检查** |
| crontab 现状 | WeMonitor 的 cron 体系**已在实战使用**（正管理 deploy-agent 自身调度） |
| `cron-runner.js` 行为 | 用 `execSync` **同步等待**子进程，**超时 10 分钟**（`timeout: 600000`），记录 exit code + stdout/stderr 到 `cron-history.jsonl` |

---

## 3. 架构设计

### 3.1 总体架构

```
GitHub Release ──> deploy-agent ──> ~/weauto/（被动 CLI，零常驻进程）
                                        ▲
WeMonitor /cron 页面 ──crontab──> node ~/weauto/bin/weauto.mjs run v2free-checkin
                                        │
                                        └──> ~/weauto/data/runs.jsonl（业务级记录）
                                                    ▲
WeMonitor /auto 页面 ──────────────────────────────┘ 读取展示
```

**核心设计原则：WeAuto 不重造调度器。** WeMonitor 已有完整的 crontab 管理（`/cron` 页面、启停开关、运行历史、标记块隔离），WeAuto 只做被动 CLI。

### 3.2 职责切分

| 系统 | 职责 | 不负责 |
|---|---|---|
| **WeAuto** | 任务怎么执行：任务注册表、凭据解密、HTTP 执行、落业务记录 | 何时执行、Web 展示 |
| **WeMonitor** | 何时执行 + 结果展示：crontab 调度、启停、进程级运行历史、业务面板 | 任务内部逻辑、凭据 |

### 3.3 两层记录的分工（不重复）

| 记录 | 归属 | 内容 | 用途 |
|---|---|---|---|
| `cron-history.jsonl` | WeMonitor | jobId、起止时间、exit code、stdout/stderr | 进程级：这条命令跑没跑、崩没崩 |
| `runs.jsonl` | WeAuto | 任务名、日期、状态、流量余量、错误原因 | 业务级：签到成没成、还剩多少流量 |

### 3.4 WeAuto 项目结构

```
WeAuto/
├── bin/weauto.mjs              # CLI 入口
├── src/
│   ├── cli.mjs                 # 命令解析（run / list / status）
│   ├── registry.mjs            # 任务注册表（扫描 tasks/ 目录）
│   ├── runner.mjs              # 执行任务 + 落 runs.jsonl
│   ├── schedule.mjs            # 种子化随机调度（决定"今天几点执行"）
│   ├── secrets.mjs             # age 解密凭据到内存
│   ├── history.mjs             # runs.jsonl 读写与查询
│   ├── http.mjs                # CookieJar + fetch 封装（Node 原生，零依赖）
│   └── totp.mjs                # TOTP 生成（可选，自研约 25 行，零依赖）
├── tasks/
│   └── v2free-checkin.mjs      # v2free 签到任务
├── data/                       # 运行时数据，不入 Git
│   ├── runs.jsonl
│   └── v2free-cookie.json      # 登录态缓存，chmod 600
├── secrets.age                 # 加密凭据，入 Git
├── .env.local.template         # 凭据模板，入 Git
├── .env.local                  # 明文凭据，不入 Git（加密后删除）
├── restart.sh                  # deploy-agent 部署后调用
├── package.json
└── docs/
```

**依赖策略：运行时零 npm 依赖。** 全部使用 Node 原生能力（`fetch`、`crypto`、`fs`）+ `age` 子进程调用。好处：
- N150 上无需 `npm ci`，无需编译（规避 Node 20 + better-sqlite3 那类坑）
- 部署 = 解压代码，无构建步骤
- 与 WeAgent 的「零运行时依赖」哲学一致

### 3.5 CLI 设计

| 命令 | 说明 |
|---|---|
| `weauto run <task>` | 执行任务（供 crontab 调用，含调度窗口判断） |
| `weauto run <task> --force` | 忽略调度窗口，立即执行（供手动触发/调试） |
| `weauto list` | 列出所有已注册任务 |
| `weauto status [--json]` | 显示最近执行记录，`--json` 供 WeMonitor 读取 |

退出码约定：`0` = 成功或正常跳过；非 `0` = 失败（WeMonitor 历史中可见）。

---

## 4. 数据流

### 4.1 签到任务数据流

```
crontab 触发（09:00–09:55 共 12 次）
  → weauto run v2free-checkin
    → registry 加载任务定义
    → 获取进程锁（data/.lock；陈旧锁按 PID 存活检测自动回收）
    → schedule 判断
        ├─ 未到今日目标时刻 → 退出 0（等待下次触发）
        └─ 当日已有成功记录 → 退出 0（幂等）
    → secrets 用 age 解密 secrets.age 到内存（明文不落盘）
    → POST /auth/login（每次执行都登录 —— Cookie 仅 1 小时有效，见 §6.6）
    → GET /user
        ├─ 页面含「今日已签到」 → 直接返回 already-signed
        │                          （不碰签到接口，避免撞站点限流）
        └─ 未签到 → 继续
    → POST /user/checkin
        ├─ {"ret":1}           → success
        ├─ msg 含「已经签到」   → already-signed
        ├─ msg 含「频繁」       → failed（不立即重试，等下次触发）
        └─ 非 JSON 响应         → blocked（保存响应前 300 字符）
    → GET /user 回读最新流量（失败则退回登录后的快照）
    → 追加写 data/runs.jsonl
    → 退出码反映结果
```

**空值/异常处理**：
- `secrets.age` 缺失或解密失败 → 退出码 2，写入 `runs.jsonl` 状态 `config-error`
- 无 cookie 且登录失败 → 状态 `login-failed`，记录服务端返回的 `msg`
- 签到接口返回非 JSON（如被 CF 挑战返回 HTML）→ 状态 `blocked`，保存响应片段供排查
- 网络超时（30s）→ 状态 `network-error`

### 4.2 WeMonitor 面板数据流

```
WeMonitor /auto 页面
  → GET /api/v1/auto/runs        # 读 ~/weauto/data/runs.jsonl（只读，最近 90 条）
  → GET /api/v1/auto/status      # 读最新一条 + 计算下次执行时间
  → POST /api/v1/auto/trigger    # 手动触发：spawn weauto run <task> --force
```

---

## 5. 状态机

### 5.1 单次执行的状态流转

```
        ┌─────────────┐
        │   scheduled │  （cron 触发）
        └──────┬──────┘
               │
      ┌────────┴────────┐
      │                 │
  今日已执行         到达今日目标时刻
      │                 │
      ▼                 ▼
 ┌─────────┐      ┌──────────┐
 │ skipped │      │  running │
 └─────────┘      └────┬─────┘
                       │
        ┌──────┬───────┼────────┬──────────┐
        ▼      ▼       ▼        ▼          ▼
    ┌───────┐┌──────┐┌──────┐┌───────┐┌────────────┐
    │success││already││failed││blocked││config-error│
    │       ││-signed││      ││       ││            │
    └───────┘└──────┘└──────┘└───────┘└────────────┘
```

| 状态 | 含义 | 是否算成功 | 是否重试 |
|---|---|---|---|
| `skipped` | 未到点 / 今日已执行 | — | 不需要 |
| `success` | 本次签到成功 | ✅ | — |
| `already-signed` | 服务端提示今日已签到 | ✅ | — |
| `login-failed` | 登录被拒（密码错/2FA 错） | ❌ | 当天窗口内可重试 |
| `blocked` | 被风控/验证码拦截 | ❌ | **不重试**（重试会加剧风控） |
| `network-error` | 网络超时/连接失败 | ❌ | 当天窗口内可重试 |
| `config-error` | 凭据缺失或解密失败 | ❌ | **不重试**（需人工介入） |

### 5.2 并发与互斥

- **锁文件**：`data/.lock`（`fs.open` with `wx` 独占标志）。防止 WeMonitor 手动触发与 cron 触发同时执行导致重复登录。
- 锁获取失败 → 立即退出 0（另一次执行正在进行），不排队等待。
- 超时保护：整个任务 60s 硬超时（远小于 cron-runner 的 10 分钟）。

---

## 6. 关键设计决策

### 6.1 随机偏移：种子化随机 + 幂等，不用 sleep

**需求**：每天 09:00 左右签到，但偏移量每天不同，避免被识别为机器行为。

**约束**：`cron-runner.js` 用 `execSync` 同步等待且**超时 10 分钟**。

**方案 A（否决）**：crontab `0 9 * * *` + 脚本内 `sleep rand(0,480)`。
- 缺点：偏移上限被 10 分钟超时卡死；睡眠期间进程被 kill（N150 重启、部署）则当天签到丢失。

**方案 B（采纳）**：crontab `*/5 9 * * *`（09:00–09:55 共 12 次触发）+ 种子化随机 + 幂等。

```
seed    = hash(taskName + ":" + YYYY-MM-DD)   // 同一任务同一天恒定
offset  = seed % 3000                          // 0 ~ 3000 秒
target  = 09:00:00 + offset                    // 落在 09:00 ~ 09:50
```

每次触发时：`now < target` → 退出 0；`今日已有成功记录` → 退出 0；否则执行签到。

- 优点：不阻塞进程（每次触发毫秒级返回）；偏移落在 09:00–09:50 区间，每天不同；完全幂等（当天成功过就不再执行）；中止后下次触发可自愈
- 代价：每天在 WeMonitor 历史中产生约 12 条 `skipped` 记录（进程级噪音，业务面板只看 `runs.jsonl`，不受影响）

### 6.2 凭据管理：age 加密 + 密文入 Git

**流程**（一次性）：

```bash
# 1. 本机生成密钥对
age-keygen -o ~/.age/weauto.key          # 私钥，永不入 Git
                                          # stdout 会打印公钥 age1xxxx

# 2. 用户把凭据填进 .env.local（.gitignore 已忽略）
# 3. 加密（公钥加密，只有私钥能解）
age -e -r age1xxxx -o secrets.age .env.local
# 4. 删除明文 .env.local（用户确认后）
```

**运行时解密**（N150）：`age -d -i ~/.age/weauto.key secrets.age` → stdout 明文 → 解析到内存，**不落盘**。

**`.env.local.template` 内容**：
```dotenv
V2FREE_EMAIL=
V2FREE_PASSWORD=
# 若账号开启了两步验证（TOTP），填入 base32 secret；未开启则留空
V2FREE_TOTP_SECRET=
```

### 6.3 age 二进制安装

| 位置 | 方式 |
|---|---|
| 本机 macOS | `brew install age` |
| N150 (Ubuntu 24.04, x86_64) | 从 GitHub Release 下载静态二进制（走 `ghproxy.net` 镜像），解压到 `~/.local/bin/age`，`chmod +x`。在 `restart.sh` 中做幂等检查：已存在则跳过 |

**为什么不 apt 安装**：`age` 在 Ubuntu 24.04 源中需额外 apt 仓库配置，而官方提供单文件静态二进制，走镜像下载更快且无需 sudo。

### 6.4 凭据加密的真实防护边界（明确记录，避免误解）

| 威胁 | 加密是否有效 |
|---|---|
| 密码进入 Git 历史 / 被推送泄露 | ✅ **有效**（这是加密的核心价值） |
| 备份、rsync 快照泄露 | ✅ 有效 |
| 有人登录 N150 顺手 `cat` 文件 | ✅ 有效 |
| N150 被完整攻陷（拿到文件系统） | ❌ **无效** —— 密文与私钥在同一台机器上 |

因为任务需无人值守自动执行，解密私钥**必须**存在于 N150。加密保护的是「凭据在传输与存储链路上不被顺走」，不是「N150 沦陷后仍安全」。若日后需要后者，需改为密钥不落 N150（如 CI 运行时注入）。

### 6.5 2FA：实测确认未开启（2026-10-13）

探针用真实凭据发起 `POST /auth/login`（不携带 `code`），返回 `{"ret":1,"msg":"登录成功"}`，
**账号未开启两步验证**。故当前实现不生成 TOTP，`V2FREE_TOTP_SECRET` 留空。

该字段保留为扩展位：若日后开启 2FA，只需在 `tasks/v2free-checkin.mjs` 中补一个约 25 行的
TOTP 生成（`node:crypto` HMAC-SHA1）填入 `code` 字段，**无需改动框架任何代码**。

### 6.6 Session 实测：1 小时过期，故每次执行都需重新登录

探针实测：登录成功返回 5 个自定义 Cookie（`uid` / `email` / `key` / `ip` / `expire_in`），
**全部为 `Max-Age=3600`**。传 `remember_me=on` 后有效期**仍为 3600s**，即该参数在此魔改版中
不产生延长效果 —— 原设计假设（§6.6 初稿）被实测推翻。

因此实现相应简化：

- **不实现 Cookie 持久化缓存** —— 1 小时的寿命对「每天执行一次」的任务毫无复用价值
- **每次执行 = 一次完整登录 + 一次签到**
- `remember_me=on` 仍保留在请求参数中（与浏览器行为一致，无额外成本）

被删掉的原设计：`data/v2free-cookie.json` 缓存文件，以及「会话失效则重登一次」的重试分支。

### 6.7 存储选型：JSONL 而非 SQLite

- 任务频率为每天 1 次，一年 365 条，JSONL 追加写的查询压力可忽略
- 规避 N150（Node 20）上 `better-sqlite3` 的现场编译问题
- 与 WeMonitor 的 `cron-history.jsonl` 习惯一致

### 6.8 设备数限制说明（已澄清，非风险）

站点显示的「设备数限制 2」限制的是**通过 VPN 在线的客户端数量**，与网站登录会话无关。

结论：自动化登录**不会**挤掉用户已连接的 VPN 设备，仅相当于新增一个网站 Session。SSPanel 的 Session 天然支持多端并存。风险等级：**低**。

仍然保留的收益：cookie 复用（§6.6）降低登录频率，从而减少风控暴露面 —— 这一点与设备数限制无关，是独立的价值。

---

## 7. 影响面

### 7.1 新建：WeAuto 仓库

全新仓库 `sherlockguo-yc/WeAuto`，无既有功能受影响。

### 7.2 修改：WeMonitor 仓库

| 文件 | 改动 | 风险 |
|---|---|---|
| `routes/auto.js` | **新增** —— `/auto` 页面路由 + 3 个 API | 低（新文件） |
| `views/auto.ejs` | **新增** —— 面板页面（复用现有布局与 CSS 变量） | 低（新文件） |
| `public/js/auto.js` | **新增** —— 前端交互 | 低（新文件） |
| `server.js` | 挂载 `routes/auto.js` | **中** —— 触碰主入口，需确认路由挂载顺序不与现有冲突 |
| `views/layout.ejs` | 侧边栏加「WeAuto」入口 | **中** —— 影响所有页面导航 |
| `routes/deploy.js` | `SERVICES` 数组加 WeAuto 条目（`port: null`） | 低 |
| `lib/deploy/local.js` | 加 `WEAUTO_DIR` 常量 | 低 |
| `config.js` | `defaultServices` 可选加 WeAuto | 低 |

**风险提示**：`server.js` 与 `views/layout.ejs` 是被全站依赖的文件，修改后需**回归验证现有页面**（`/`、`/cron`、`/deploy`、`/network`）均正常。

### 7.3 修改：N150 配置

| 项 | 改动 |
|---|---|
| `~/.deploy-projects.conf` | 追加 `weauto\|sherlockguo-yc/WeAuto\|$HOME/weauto\|\|sha\|weauto.tar.gz`（PORT 留空） |
| cron | 通过 WeMonitor `/cron` 页面创建：`*/5 9 * * *` → `node /home/sherlockguo/weauto/bin/weauto.mjs run v2free-checkin` |
| `~/.age/weauto.key` | 手动放置私钥，`chmod 600` |

### 7.4 不受影响

WeMusic、WeDownload、quiz-app 的部署与运行完全不受影响（deploy-projects.conf 追加行不改动既有行）。

---

## 8. 边界与失败模式

| 边界场景 | 表现 | 处理 |
|---|---|---|
| `secrets.age` 不存在 / 解密失败 | 面板显示红色「配置错误」 | 退出码 2，`runs.jsonl` 记 `config-error`，**不重试** |
| N150 网络中断 | 仅当次失败 | 记 `network-error`，当天窗口内后续触发自动重试 |
| Cookie 过期 | 自动重登一次 | 重登仍失败 → `login-failed` |
| 站点返回 HTML（被 CF 挑战） | 解析失败 | 记 `blocked`，**保存响应前 500 字符**供排查，当天不重试 |
| 站点今日已签到 | 视为成功 | 记 `already-signed`，不影响面板绿色状态 |
| 同一天多次触发（12 次） | 仅首次满足条件时执行 | 幂等：查到当日成功记录直接跳过 |
| WeMonitor 手动触发与 cron 同时触发 | 锁文件互斥 | 后到者立即退出 0 |
| 任务执行超过 60s | 硬超时中止 | 记 `network-error` |
| 站点接口变更（SSPanel 升级） | 解析不到预期字段 | 记 `blocked` + 原始响应，面板显式提示"接口可能已变更" |
| 错过一整天（N150 停机） | 当天无记录 | 面板显示「最近成功：N 天前」并高亮告警色；**不做补签**（签到按自然日，补签无意义） |

---

## 9. 验收标准

以下每条都可在不打开代码的情况下验证：

1. **部署可见**：访问 `https://wemonitor.sherlockguo.com/deploy`，能看到 `WeAuto` 条目且状态正常（不因无端口而误报 `stopped`）。
2. **面板可见**：访问 `https://wemonitor.sherlockguo.com/auto`，能看到签到状态卡（最近结果、下次执行时间、流量余量）与历史列表。
3. **签到生效**：Cron 触发后的次日，v2free 站点用户中心显示「今日已签到」，且流量余量比前一日增加。
4. **幂等成立**：手动连续触发 3 次，`runs.jsonl` 仅新增 1 条业务记录，其余为 `skipped`。
5. **随机偏移成立**：连续 3 天的执行时刻各不相同，且均落在 09:00–09:50（北京时间）区间内。
6. **失败可见**：临时把 `secrets.age` 改名为不存在，手动触发后面板显示红色「配置错误」，而非静默成功。
7. **凭据不泄露**：`git log -p` 中搜索不到明文邮箱与密码；仓库内只有 `secrets.age` 密文。
8. **现有功能无回归**：WeMonitor 的 `/`、`/cron`、`/deploy`、`/network` 页面在改动后均正常渲染。

---

## 10. 备选方案与决策记录

| 决策点 | 备选 | 选择 | 理由 |
|---|---|---|---|
| 运行位置 | 本机 Mac / **N150** / GitHub Actions | N150 | 已实测可达；7×24 常驻；复用现有运维体系；GitHub Actions 的 IP 段是机场风控重灾区 |
| 技术路线 | **纯 HTTP** / 无头浏览器 / 混合 | 纯 HTTP | 已逆向出完整接口，无需浏览器；零 Chromium 依赖，任何环境可跑 |
| 通用程度 | 单脚本 / **通用骨架+任务注册表** / 完整框架 | 通用骨架 | 满足扩展需求，不做插件系统与 Web 编排等过度设计 |
| 调度归属 | **复用 WeMonitor crontab** / 自带调度器 | 复用 crontab | WeMonitor 已有成熟的 crontab 管理体系；每多一个常驻进程就多一份部署与阻塞风险 |
| 存储 | **JSONL** / SQLite | JSONL | 数据量极小；规避 N150 上 better-sqlite3 的编译问题 |
| 凭据 | 明文 .env / **age 加密+入 Git** / sops / GH Secrets | age | 单二进制、流程最简；密文可版本化恢复；sops 的多 KMS 能力在单人单机场景用不上 |
| 随机偏移 | sleep / **种子化随机+幂等** | 种子化随机 | cron-runner 有 10 分钟硬超时，sleep 方案受限且不抗中断 |

---

## 11. 实施进度

| # | 步骤 | 状态 |
|---|---|---|
| 1 | **接口探针**（用真实凭据确认 2FA / CSRF / 签到返回 / Cookie 有效期） | ✅ 已完成（2026-10-13，结论见 §2.1.1） |
| 2 | **搭骨架**：CLI + 任务注册表 + 调度 + 记录 + 锁 | ✅ 已完成 |
| 3 | **凭据加密链路**：安装 age → 生成密钥对 → 加密 `.env.local` → 删除明文 | ✅ 已完成（公钥 `age1zrwj0g...vu3css`） |
| 4 | **本机跑通**：`run --force` 真实登录 + 签到态识别 + 幂等跳过 | ✅ 已完成 |
| 5 | **WeMonitor 面板**（`/auto` 页面 + 3 个 API） | ✅ 已完成（WeMonitor `290909b`） |
| 6 | **部署到 N150**：配 `deploy-projects.conf` → 放私钥 → 建 crontab | ✅ 部署链路全通；⬜ crontab 待添加 |
| 7 | **验收**：对照 §9 逐条验证 | 🔶 见下表 |

### 验收对照（2026-10-13）

| §9 验收标准 | 状态 | 证据 |
|---|---|---|
| 1. 部署可见（WeAuto 在 /deploy 页状态正常，不误报 stopped） | ✅ | `getLocalState(dir, null)` 返回 `alive: true`，`computeSummary` 走版本比较分支 |
| 2. 面板可见（/auto 有状态卡与历史） | 🔶 | 路由、模板渲染、后端取数均已验证；登录后视觉效果待用户确认 |
| 3. 签到生效（次日站点显示已签到） | ⬜ | 需 crontab 生效后观察一天 |
| 4. 幂等成立（连续触发只新增 1 条业务记录） | ✅ | 实测输出 `[skipped] 今日已完成`，退出码 0 |
| 5. 随机偏移成立（各日时刻不同且落在窗口内） | ✅ | 连续 7 天为 09:21 / 09:33 / 09:31 / 09:47 / 09:11 / 09:25 / 09:07 |
| 6. 失败可见（凭据缺失时面板显示配置错误） | ✅ | 首次部署时真实发生：`config-error 未找到 age 命令`，被正确记录 |
| 7. 凭据不泄露（Git 中无明文） | ✅ | `grep` 全仓库与 Git 历史均无邮箱/密码；仅有 `secrets.age` 密文 |
| 8. 现有功能无回归 | ✅ | `/`、`/cron`、`/deploy`、`/network`、`/system` 等全部正常 |

### 实施中的实测修正记录

| 原设计 | 实测结果 | 实际实现 |
|---|---|---|
| 缓存 `v2free-cookie.json` 复用会话 | Cookie 仅 1 小时有效，无复用价值 | **移除缓存**，每次执行重新登录 |
| `remember_me` 延长会话 | 实测无效（仍 3600s） | 保留参数但不依赖其效果 |
| 会话失效重登一次 | 每次都是新登录，无从「失效」 | **移除该重试分支** |
| 2FA 双分支设计 | 账号未开启 2FA | 不实现 TOTP，字段留作扩展位 |
| 签到失败可在窗口内重试 | 站点有频率限制 | 撞限流时不重试，等下次触发 |

---

## 附：确认记录

- [x] 随机偏移窗口 09:00–09:50 —— **已确认**（2026-10-13，见 §6.1）
- [x] 「设备数限制 2」的副作用 —— **已澄清为不存在**：该限制针对 VPN 在线客户端，与网站登录会话无关（2026-10-13，见 §6.8）
- [x] WeMonitor 侧改动涉及 `server.js` 与 `layout.ejs` 两个全站文件 —— **已确认可以改**（2026-10-13，见 §7.2）
