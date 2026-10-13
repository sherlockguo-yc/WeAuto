# WeAuto — 功能规格

> 状态：已实现（2026-10-13）
> 本文件描述**现在**怎么工作，是修改本模块前的必读项，需随实现变化同步更新。
> 「**为什么**这么设计」（方案对比、废弃方案、实测修正）见 [需求文档](../requirements/weauto.md)。

---

## 1. 系统边界

WeAuto 是一个**无端口、无常驻进程**的被动 CLI。它不负责调度，也不提供 Web 界面。

| 职责 | 归属 |
|---|---|
| 任务怎么执行：注册表、凭据解密、HTTP 执行、业务记录 | **WeAuto** |
| 何时执行：crontab 调度与启停 | WeMonitor `/cron` |
| 结果展示与手动触发 | WeMonitor `/auto` |

运行时**零 npm 依赖**：只用 Node 原生 `fetch` / `crypto` / `fs`，外加 `age` 二进制。

---

## 2. 目录结构

```
bin/weauto.mjs           CLI 入口
src/util.mjs             路径常量、dotenv 解析、时区计算（TZ = Asia/Shanghai）
src/secrets.mjs          age 解密到内存（明文不落盘）
src/http.mjs             CookieJar + fetch 封装（redirect: 'manual'）
src/history.mjs          runs.jsonl 读写、成功状态集合、幂等判断
src/schedule.mjs         种子化随机调度
src/registry.mjs         扫描 tasks/ 加载任务定义，并在加载期完成校验
src/lock.mjs             进程锁：判定陈旧/持有，带年龄兜底
src/runner.mjs           执行器：锁 → 门禁 → 幂等 → 解密 → 执行 → 记录
tasks/v2free-checkin.mjs v2free 签到任务
scripts/probe.mjs        接口探针（一次性验证脚本，保留作调试用）
tests/                   node:test 单元测试与契约测试（fixtures/ 放真实快照）
data/                    运行时数据（runs.jsonl、.lock），已 gitignore
secrets.age              age 加密的凭据（入 Git，随 Release 分发）
restart.sh               deploy-agent 部署后置脚本
```

---

## 3. 执行流程

```
crontab 触发（*/5 9 * * *，北京时间 09:00–09:55 共 12 次）
 └─ node bin/weauto.mjs run <task>
     ├─ registry 扫描 tasks/*.mjs 加载任务定义（校验失败即报错退出）
     ├─ runner 获取进程锁 data/.lock（已被占用则跳过；陈旧锁可回收，见 §12）
     ├─ 调度门禁（非 --force 时）
     │   ├─ 未到今日目标时刻 → 退出 0
     │   └─ 当日已有成功记录 → 退出 0
     ├─ secrets 调 age 解密 secrets.age 到内存（校验 requires 字段）
     ├─ task.run(ctx)，整体 60s 硬超时
     ├─ 追加一条记录到 data/runs.jsonl
     └─ 退出码：成功/已签/跳过 = 0，其余 = 1
```

`ctx` 提供给任务的内容：`{ secrets, request, CookieJar, log, now }`。

---

## 4. CLI 接口

| 命令 | 说明 |
|---|---|
| `weauto run <task> [--force]` | 执行任务。`--force` 跳过调度门禁与幂等检查 |
| `weauto list [--json]` | 列出任务。`--json` 输出 `{ tasks: [...] }`，含 `window` 与今日 `target` |
| `weauto status [--json]` | 查看执行记录。`--json` 输出 `{ last, runs }` |

**退出码**：`0` = `success` / `already-signed` / `skipped`；`1` = 其余状态。
WeMonitor 的 cron 历史据此判断成败。

---

## 5. 任务契约

在 `tasks/` 放一个 `.mjs` 文件导出任务对象即可，**无需改动任何框架代码**：

```js
export default {
  name: 'my-task',                    // 必填，唯一
  displayName: '我的任务',             // 可选，用于展示
  requires: ['MY_TOKEN'],             // 可选，解密后校验这些字段存在
  schedule: { window: { start: '09:00', end: '09:50' } },  // 可选，省略则每次触发都执行
  async run({ secrets, request, CookieJar, log, now }) {
    return { status: 'success', message: '完成', data: { /* 任意业务数据 */ } };
  },
};
```

`registry.loadTasks()` 会校验 `name` 与 `run` 是否存在、任务名是否重复、窗口字段是否完整。

---

## 6. 状态与退出码

| 状态 | 含义 | 计入「今日已完成」 |
|---|---|---|
| `success` | 执行成功 | ✅ |
| `already-signed` | 目标已达成（如服务端提示今日已签到） | ✅ |
| `skipped` | 未到点 / 当日已完成 / 锁被占用 | — |
| `failed` | 业务失败（登录被拒、站点限流等） | ❌ |
| `blocked` | 响应非预期（非 JSON、被风控），会截存响应片段 | ❌ |
| `network-error` | 网络超时或任务抛异常 | ❌ |
| `config-error` | 凭据缺失或 age 解密失败 | ❌ |

`history.SUCCESS_STATUSES = ['success', 'already-signed']` 是幂等判断的唯一依据。

---

## 7. 凭据与密钥

| 文件 | 位置 | 是否入 Git |
|---|---|---|
| 密文 | `<repo>/secrets.age` | ✅ 入 Git，且随 Release 包分发 |
| 私钥 | `~/.age/weauto.key`（可用 `WEAUTO_AGE_KEY` 覆盖） | ❌ 永不入 Git |
| 明文模板 | `.env.local.template` | ✅ 入 Git（无真实值） |
| 明文 | `.env.local` | ❌ 已 gitignore，加密后应删除 |

**age 可执行文件的解析顺序**（`secrets.mjs:resolveAgeBin`）：
`WEAUTO_AGE_BIN` 环境变量 → `PATH` 中各目录 → `~/.local/bin/age` → `/usr/local/bin/age` → `/opt/homebrew/bin/age`。

> 这一步是必需的：cron 与非交互式 shell 的 PATH 不含 `~/.local/bin`，而 `restart.sh` 正把 age 装在那里。

**为什么密文要打进 Release 包**：deploy-agent 用 `rsync -a --delete --exclude 'data' --exclude '.env'` 同步部署目录，不在包内的文件会被删除。密文不敏感，Git 是它的唯一权威来源。要更新凭据，应在本地重新加密后提交，走 Git → CI → 部署链路。

---

## 8. 调度算法

同一任务同一天的目标时刻恒定，不同天不同：

```
seed   = sha256(`${taskName}:${YYYY-MM-DD}`)
target = window.start + (seed.readUInt32BE(0) % (window.end - window.start))   // 秒
```

- 窗口默认 `09:00–09:50`，窗口跨度即随机范围
- 日期与时刻均按 `Asia/Shanghai` 计算（`Intl.DateTimeFormat` 显式指定时区，**不依赖运行环境系统时区**）
- crontab 只需在窗口内高频触发（`*/5 9 * * *`），任务自行判断是否到点

---

## 9. 部署

```
git push (main)
  → GitHub Actions（.github/workflows/deploy.yml）
  → Release: weauto.tar.gz（含 bin src tasks scripts restart.sh package.json secrets.age .version）
  → webhook / cron 轮询 → deploy-agent
  → rsync 到 ~/weauto/ → 执行 restart.sh
```

`~/.deploy-projects.conf` 中的条目（**PORT 留空**，deploy-agent 会跳过健康检查）：

```
weauto|sherlockguo-yc/WeAuto|$HOME/weauto||sha|weauto.tar.gz
```

`restart.sh` 做三件事（均为幂等）：
1. 安装 `age` 静态二进制到 `~/.local/bin`。**版本查询直连 `api.github.com`，下载走 ghproxy 镜像** ——
   ghproxy 只代理 `github.com` 的下载资源，代理 API 会返回 403「Invalid input」，
   而脚本里的 `|| true` 会把失败静默吞掉（此前一直如此，永远退回 `v1.2.1`）。
   解析 JSON 用 `node -p` 而非 `jq`，因为 `jq` 在 N150 上不保证存在。
2. 收紧权限：`data/` 700、`secrets.age` 600、私钥 600
3. 自检：用私钥解密 `secrets.age`，失败则打印警告（不中断部署）

仓库必须是 **public**：deploy-agent 查询 Release 用的 fine-grained PAT 未授权到具体仓库时会返回 404，而下载环节走 ghproxy 镜像且**不带 token**。

---

## 10. 调试

```bash
node bin/weauto.mjs list                    # 看任务与今日目标时刻
node bin/weauto.mjs run <task> --force      # 忽略门禁，立即执行
node bin/weauto.mjs status --json           # 结构化查看历史
node scripts/probe.mjs                      # 接口探针（真实登录，可用 PROBE_SKIP_CHECKIN=1 跳过签到）
```

| 环境变量 | 作用 |
|---|---|
| `WEAUTO_AGE_BIN` | 指定 age 可执行文件 |
| `WEAUTO_AGE_KEY` | 指定 age 私钥路径 |
| `PROBE_SKIP_CHECKIN=1` | 探针跳过签到请求（避免触发站点频率限制） |

---

## 11. 已知限制

1. **每次执行都要重新登录** —— v2free 的 Cookie 仅 1 小时有效，`remember_me` 实测无效，故未实现 Cookie 缓存。
2. **撞限流不重试** —— 站点对连续签到请求返回「请求过于频繁」，此时记 `failed` 并等下次 cron 触发。
3. **单任务硬超时 60s**（`runner.TASK_TIMEOUT_MS`），远小于 WeMonitor cron-runner 的 10 分钟限制。
4. **锁按 PID 判活，不跨机器** —— 单机部署下无影响。
5. **`runs.jsonl` 不轮转** —— 每天最多 1 条业务记录，一年约 365 条，暂不需要。
6. **未实现 TOTP** —— 当前账号未开启两步验证；如日后开启，需在任务内补约 25 行 TOTP 生成填入 `code` 字段。
7. **`v2free-checkin` 依赖页面结构** —— 账户数据解析自页面内嵌的 `crispSessionData` 数组，站点改版会导致解析失败（表现为 `success` 但 `data.remainTraffic` 为 null）。`tests/task-v2free.test.mjs` 基于真实页面快照，改版后需重新抓取 `tests/fixtures/`（见 §13）。

---

## 12. 进程锁

`data/.lock` 是单机互斥的唯一手段。同一任务并发执行会撞站点限流，当天签到直接作废，
所以这里的判定顺序本身就是契约（`src/lock.mjs` 的 `lockState`）：

1. **年龄兜底**：锁文件 mtime 超过 `LOCK_MAX_AGE_MS`（5 分钟）即视为可回收。
   任务硬超时只有 60s，任何合法持锁都远小于此值。
2. **内容为空 → 视为「正被持有」**。`openSync` 建文件与写入 PID 之间存在窗口，文件此刻是 0 字节；
   若判为陈旧锁并回收，两个进程就会同时执行。
3. **按 PID 判活**：`kill(pid, 0)` 抛 `ESRCH` 才算持有者已消失；`EPERM` 等一律保守视为仍被持有。

第 1 条同时封掉另一个死角：**PID 被系统复用给无关进程**时存活判断会失真，
没有年龄兜底的话锁将永远无法回收，任务从此静默停摆。

释放方式是 `unlink` 锁文件（不是清空内容）。

---

## 13. 测试

```bash
npm test        # node --test tests/*.test.mjs，零依赖，Node 内置 runner
```

CI 在打包之前执行，不过就不发 Release。

| 文件 | 覆盖 |
|---|---|
| `tests/util.test.mjs` | dotenv 解析、日期/时区换算（输入固定 UTC 时刻，结果不随机器时区漂移） |
| `tests/schedule.test.mjs` | 种子化调度：落在窗口内、跨天分散、已知锚点 `09:21`、边界是 `>=` |
| `tests/history.test.mjs` | 幂等判断三要素（任务名 + 日期 + 成功状态），以及损坏行的降级 |
| `tests/lock.test.mjs` | 锁的四类边界：空文件、死 PID、超龄、目录缺失 |
| `tests/registry.test.mjs` | 任务定义校验（含 `HH:MM` 格式与窗口合法性） |
| `tests/task-v2free.test.mjs` | 页面解析三个正则，基于真实页面脱敏后的 fixture |
| `tests/contract.test.mjs` | 跨仓库契约：status 取值集合、`list --json` 结构、退出码与错误输出 |

**跨仓库契约的另一半在 WeMonitor**（`tests/auto-contract.test.mjs`），它用同一份真实样本
校验消费侧的解析。两侧同时失败才算契约破裂；只有一侧失败，说明是那一侧的实现漂移了。
契约内容：`list --json` 的结构、`runs.jsonl` 的字段、7 个 status 取值。
