# WeAuto 多租户化（v3）—— 需求文档

> 状态：**待确认**（2026-10-14）。确认后才进入编码。
> 前序：[`weauto.md`](weauto.md)（v1 被动 CLI，已冻结）、[`weauto-standalone.md`](weauto-standalone.md)（v2 单租户服务化）
> 本文件回答「**为什么**这么做」与「**怎么**做」；实现完成后现状描述写入 `docs/功能规格/weauto.md`。

---

## 1. 用户场景与语义澄清（先读这一节）

### 1.1 一句话

**作为一个被邀请来的用户，我希望用自己的账号在 WeAuto 上启用现成的自动化模板（填我自己的凭据、配我自己的时间），看到属于我的执行结果，而看不到别人的。**

### 1.2 「建立自己的自动化任务」的边界（已确认 2026-10-14）

**用户能做的**：对平台已有的模板创建「实例」（订阅），配自己的凭据与时间。
**用户不能做的**：自己创造一个新模板——例如「xxx 网页自动签到」这种平台没开发的自动化，用户既建不出模板，也建不出它的实例。

| 解读 | 例子 | 本方案 |
|---|---|---|
| **任务实例** | 启用 v2free 签到模板，配置「每天 09:00，用我的账号」 | ✅ 支持 |
| **任务类型** | 自己搞出「xxx 网页自动签到」这个新自动化 | ❌ 不支持 |

模板的唯一来源是 `tasks/*.mjs` 代码文件，随部署发布（D1 决策不变）。**平台开放的是「用」，不是「造」。**

一句话概括产品形态：**平台提供能力，用户配置副本。**

### 1.3 三个具体场景

1. 你生成邀请链接发给朋友 → 打开 → 建号 → 看到模板列表 → 启用「v2free 签到」→ 填自己的账号密码 → 选「每天 09:00」→ 次日看到签到结果与流量余量。
2. 朋友的首页、历史、凭据页**只有他自己的数据**，看不到你的。
3. 你（admin）额外看到平台视角：多少用户、多少活跃订阅、谁在失败。

---

## 2. 已确认决策

| # | 决策 | 取值 | 影响 |
|---|---|---|---|
| **D5** | 任务形态 | **A：模板平台**（用户启用模板，不写代码） | 任务类型仍由代码定义；数据模型从「单租户」改「多租户」 |
| **D6** | 注册门槛 | **邀请码 / 一次性链接** | 陌生人无法进入；你不需手工填密码 |
| **D7** | 本次范围 | **先出设计，确认后编码** | 本文档 |
| **D8** | 账号体系 | **保持 WeAuto 独立**，不与 WeMusic / WeMonitor 打通 | 沿用 v2 §13 结论；改造只在 WeAuto 内 |
| **D9** | 模板边界 | **模板只能由平台（代码）提供；用户只能创建模板的实例，不能创建模板** | 见 §1.2 与 §4.6；这是本方案的安全边界，不是「暂时没做」 |

---

## 3. 现状：五处单租户假设（本次改动的全部来源）

| # | 位置 | 现状 | 为什么挡路 |
|---|---|---|---|
| 1 | `src/registry.mjs` | 任务 = `tasks/*.mjs` 代码文件，全站一份 `Map<name, task>` | 没有「模板 vs 我的实例」之分 |
| 2 | `src/db.mjs` v2 `tasks` 表 | 主键 `task_name`（覆盖层 enabled/schedule/timeout） | 「启用/停用」是全站级，不是每人一份 |
| 3 | `src/db.mjs` v2 `runs` / `run_logs` / `run_stats_daily` | 无 `user_id`，只按 `task_name` 聚合 | 陌生人会看到**你的**签到历史 |
| 4 | `src/db.mjs` v2 `task_state` 表 | 主键 `task_name`，今日目标时刻全站唯一 | 两人各配「每天 09:00」会互相覆盖 |
| 5 | `src/secrets.mjs` + `src/credentials.mjs` | 凭据 = `data/secrets.age` 全站一份，一把 age 私钥 | 无法为每个用户存各自的账号密码 |

**非代码约束**：所有请求的出口 IP 是 N150 这一个 IP（见 §8 风险 1）。

**已预留、本次正好用上的两处**（不用新造概念）：
- `runs.account_key`（建表时注释「为多账号预留（当前恒为 NULL）」）
- 任务契约 `accounts: boolean`（`src/task-contract.mjs`，声明该模板是否支持多账号）

---

## 4. 目标架构

### 4.1 概念模型

```
Template（模板：tasks/*.mjs，全局，由部署新增，用户不可创建）
   │  用户启用
   ▼
Subscription（订阅 = 用户 × 模板：enabled / schedule / timeout）
   │  模板声明 accounts: true 时可配多份
   ▼
Account（账号：订阅下的一组凭据，用 account_key 区分）
   │  执行
   ▼
Run（执行记录，归属于 用户 + 模板 + account_key）
```

### 4.2 数据模型 —— 迁移 v3

约定（沿用 `src/db.mjs` 顶部）：**只追加，不改已发布的迁移**。

新增表：

```sql
-- 邀请码
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,              -- base64url(32 字节随机)
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,                       -- NULL = 长期有效
  max_uses   INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  used_by    INTEGER REFERENCES users(id),  -- 单次码回填，便于追溯
  revoked_at INTEGER,
  note       TEXT                           -- 给谁的，备查
);

-- 每用户凭据（密文，见 §4.3）
CREATE TABLE IF NOT EXISTS user_secrets (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_name   TEXT    NOT NULL,
  account_key TEXT    NOT NULL DEFAULT '',
  field       TEXT    NOT NULL,
  value_enc   BLOB    NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, task_name, account_key, field)
);

-- 订阅（原 tasks 覆盖层的多租户版）
CREATE TABLE IF NOT EXISTS subscriptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_name     TEXT    NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  schedule_json TEXT,
  timeout_ms    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (user_id, task_name)
);

-- 订阅下的账号（accounts: true 的模板才有多条；否则一条 account_key=''）
CREATE TABLE IF NOT EXISTS subscription_accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  account_key     TEXT    NOT NULL DEFAULT '',
  label           TEXT    NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  UNIQUE (subscription_id, account_key)
);
```

现有表改造：

| 表 | 改动 | 说明 |
|---|---|---|
| `runs` | `ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1` + `subscription_id INTEGER` | SQLite 加列不能带外键；`DEFAULT 1` 正好把历史行归给首个用户 |
| `runs` 索引 | 新增 `idx_runs_user_task_ts (user_id, task_name, ts DESC)` | 所有页面查询都带 `user_id` |
| `run_logs` | `ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1` | **冗余**而非 JOIN `runs`：保留策略要按用户清理日志，JOIN 每次全表扫。代价是写两遍，接受 |
| `run_stats_daily` | 主键变 `(user_id, task_name, date)` → **需重建表** | 建新表 → `INSERT SELECT 1, ...` → `DROP` → `RENAME` |
| `task_state` | 主键变 `(user_id, task_name, account_key)` → **需重建表** | 同上 |
| `tasks`（旧覆盖层） | **保留不删**，新代码只读不写 | 追加式迁移的代价；真正删除留到稳定后的 v4 |

### 4.3 凭据加密：三选一

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| 1 | age 每用户一个文件 `data/secrets/<user_id>.age` | 沿用既有工具与心智模型 | 每次解密 `execFileSync` fork 一个进程；20 个用户同时到期 = 20 个进程；文件数随用户膨胀 |
| **2（推荐）** | **进程内 AES-256-GCM 存 DB**：主密钥 `WEAUTO_MASTER_KEY`（`data/` 下，600 权限，首次启动生成），每字段随机 nonce，密文存 `user_secrets.value_enc` | 进程内解密（微秒级）；天然按 `(user, task, account)` 粒度；与 DB 事务一致；Node `crypto` 原生支持，约 40 行 | 需自己写加解密 |
| 3 | age 加密后当 blob 存 DB | 沿用 age | 每字段 fork 一次进程，最差 |

**选 2 的理由**：调度器每 30 秒 tick 一次，要为所有到期订阅解密凭据。方案 1/3 的 fork 成本在这个循环里会放大成量级问题。

**威胁模型（必须如实写）**：方案 2 与现状**安全级别相同**——都是「服务器被拿下 = 凭据全丢」。age 私钥今天也躺在同一台机器上。它防的是**DB 文件 / 备份泄露**，不防主机入侵。**不要对外宣称「端到端加密」**。

由此产生一个必须告知用户的事实：**admin 技术上能解密所有用户的凭据**。建议注册页与凭据页写明这一点（见 §10 问题 6）。

### 4.4 调度器改造

现状（`src/scheduler.mjs`）：`tick()` 遍历 `tasks.values()`，`inFlight` key 是 `taskName`，状态读写是 `store.stateOf(task.name)`。

改为遍历**活跃订阅 × 账号**：

- `inFlight` key → `${subscriptionId}:${accountKey}`
- `planTask()` 是纯函数，**签名不变**；变的只是喂给它的参数来源：
  - `store.stateOf(task.name)` → `store.stateOf(userId, taskName, accountKey)`
  - `hasSuccessOn` / `hasScheduledRun` 同样增加维度
- **全局并发闸门**：`MAX_CONCURRENT_RUNS = 4`——20 个用户同时到期时不能打出 20 路请求
- **单用户串行**：同一用户最多 1 个在飞，避免自己打自己
- **配额（已定，宽松档）**：`QUOTA_PER_USER_DAY = 100`（每日每用户 100 次执行）、`MIN_INTERVAL_MINUTES = 5`（interval 下限，低于此值拒绝保存）、`MAX_SUBSCRIPTIONS_PER_USER = 20`。超限写 `skipped` 并记明原因
- 用户 `status='disabled'` → 其所有订阅跳过
- **幂等必须按账号维度**：`hasSuccessOn` 要带上 `account_key`。否则同一用户下 A 账号签到成功后，B 账号会被判「今日已完成」而跳过——这正是多账号最容易踩的坑

### 4.5 执行链路（低风险接缝，本次改造的关键）

现成的注入点：

```37:38:src/executor.mjs
export function createExecutor({ store, secretsLoader = loadSecrets, now = () => Date.now(), log = () => {} }) {
```

改为注入 `secretsLoader = (taskName, accountKey) => loadUserSecrets(userId, taskName, accountKey)`，**执行器主体不动**。
`src/runner.mjs` 里的 `loadSecrets(task.requires)` 同样替换（CLI 路径用 `--user` 指定）。

### 4.6 模板的边界与可见性（D9 的落地）

D9 不是一句口号，它需要在三个地方有实际约束：

**1. 创建实例时的校验（安全边界）**
`POST /api/subscriptions` 拿到 `task_name` 后必须校验它存在于 `registry.loadTasks()` 的结果里。**不在 registry 里就直接拒绝**——否则用户可以传任意字符串，轻则造出垃圾订阅，重则在将来引入「按名字动态加载」时被利用。
校验失败的响应：**未公开的模板返回 404 而不是 403**（403 会证实「这个名字存在但你不配用」，等于泄露模板清单）。

**2. 模板的可见性分级**
建议给任务契约加一个字段（默认 `public`）：

```js
visibility: 'public' | 'internal'   // 默认 public
```

- `public`：出现在所有用户的模板市场，任何用户可建实例
- `internal`：只有 admin 能建实例。用途有两类
  - 你自己专用的自动化，不该出现在别人的市场里
  - 尚未准备好的模板（还在调试），可以先上线给自用，稳定后再改 `public`

不加这个字段的话，所有模板对所有人可见，包括你正在调试的半成品。

**3. 模板下线后，已有实例怎么办**
模板是代码，删文件即下线。但用户的实例行还在库里。约定：
- 订阅保留，不级联删除（用户可能只是暂时下线，删了要重建 + 重填凭据）
- 页面显示「模板已下线」，不可执行、不可改配置，历史记录仍可读
- 调度器遍历时跳过（拿不到 task 定义就没有 `schedule`，自然跳过）

---

## 5. 页面与路由改造

`src/server.mjs` 现有 20 条路由，改造要点：

| 路由 | 变化 |
|---|---|
| `/` 概览 | 从「全站」变「我的」；admin 可切换「全部」视图 |
| `/tasks` | 改为「模板市场（可启用）+ 我的订阅」两栏 |
| `/tasks/:name` | 定位到具体订阅：`/tasks/:name?sub=<id>` |
| `/credentials` | → `/my/credentials`：只列自己的（按模板 × 账号分组） |
| `/settings` | admin 增加「邀请码管理」 |
| **新增** `/register?code=xxx` | 邀请码注册 |
| **新增** `/admin` | 平台概览：用户数、活跃订阅、失败排行（可选，见 §10 问题 5） |

API：`/api/*` 全部按 `req.user.id` 过滤。特别注意 `POST /api/tasks/:name/run` —— 语义从「跑这个全站任务」变成「跑我的这个订阅」。

**页面改造的源头是 `src/status.mjs`**：`summarizeAll({ tasks, store, nowMs })` 与 `summarizeTask({ task, store, nowMs })` 需要增加 `userId` / 订阅维度参数，下游页面才拿得到「我的」数据。

---

## 6. 邀请码注册流程

1. admin 在 `/settings` 生成：`POST /api/invites` → `{ code, url }`，参数 `{ expiresInDays, maxUses, note }`
2. 链接形如 `https://weauto.sherlockguo.com/register?code=xxx`
3. `GET /register`：校验码存在 / 未过期 / 未用完 / 未撤销 → 显示表单；否则显示具体原因
4. `POST /register`：
   - **服务端重新校验 code**（不能只信表单里的隐藏字段，那可被篡改）
   - 用户名/密码规则复用 `validateNewCredentials`
   - **在同一个事务里**：建 user + `used_count += 1` + 单次码回填 `used_by` → 防止并发重放（同一码被两人同时提交）
   - 成功后直接签发会话（体验连续），跳转首页
5. **限速**：复用 `config.LOGIN_RATE_LIMIT` 的内存计数器模式，按 IP 与按 code 双重限制。32 字节随机码本身不可暴力猜，限速是防打库
6. **角色**：邀请码注册固定 `role='user'`；`admin` 只能由 admin 后台升级（`PATCH /api/users/:id`）
7. **关闭开关**：`WEAUTO_INVITE_ONLY=1`（默认）时 `/register` 无码不可用。保留未来开放注册的可能，但默认不开

失败模式：

| 情况 | 行为 |
|---|---|
| 码不存在 / 已过期 / 已用完 / 已撤销 | `GET` 显示原因，`POST` 返回 403 |
| 并发重放同一单次码 | 事务 + `used_count` 检查，第二个请求失败 |
| 注册中途失败（用户名冲突等） | 整个事务回滚，`used_count` 不增加 |
| 用户名已存在 | 复用既有 `exists` 错误码 |

---

## 7. 数据迁移与兼容（v3 迁移做三件事，同一事务）

1. 建新表（§4.2）
2. **凭据迁移**：`readSecrets()` 读出全部明文 → 用主密钥加密 → 逐字段写入 `user_secrets(user_id=1)`。`data/secrets.age` **保留不删**，作为回滚依据
3. **数据回填**：`tasks` 覆盖层 → 复制成 `subscriptions(user_id=1)`；`runs` / `run_logs` / `run_stats_daily` / `task_state` 回填 `user_id=1`（前两者靠 `DEFAULT 1` 自动完成，后两者在重建表时 `INSERT SELECT`）

前置条件：迁移时 `users` 表至少有一个账号（你自己）。若为空（还没走 setup），跳过回填部分。

回滚：v3 只新增表 + 加列，旧表不删 → 出问题时旧代码仍可读。真正 `DROP TABLE tasks` 留到稳定后的 v4。

---

## 8. 边界与失败模式（提前承认）

| # | 风险 | 等级 | 应对 |
|---|---|---|---|
| 1 | **出口 IP 共享**：所有用户的请求都从 N150 同一个 IP 发出。目标站若对同 IP 多账号做风控，会**连坐** | 高 | 错峰（现有 `targetSecondsOfDay` 已按任务名种子化，需扩展到按用户）；长期要评估是否值得让多人共用出口 |
| 2 | admin 能解密所有用户凭据 | 中 | 如实告知；凭据值永不进日志与 API 响应 |
| 3 | 邀请码被转发到公开群 | 中 | 默认单次使用 + 7 天过期；admin 可撤销 |
| 4 | 用户滥用（interval 配 1 分钟刷目标站） | 中 | 每用户每日配额 + interval 下限（建议 ≥5 分钟）+ 全局并发闸门 |
| 5 | 主机被入侵 = 全部用户凭据泄露 | 高 | 与现状**同级**，不因本次改造变差；但**影响面从 1 人变成 N 人**，这是真正的风险放大项 |
| 6 | 删除用户后的数据清理 | 低 | 订阅 / 账号 / 凭据走 `ON DELETE CASCADE`；`runs` 建议一并删除（留 user_id=NULL 会让统计出现幽灵行） |
| 7 | N150 单机无 HA，用户变多后可用性责任上升 | 中 | 本次不解决。**单台家用机器做公共服务前要单独重评**（见 §10） |

---

## 9. 验收标准

1. 用邀请链接注册的新用户，登录后 `/` 只看到自己的任务与历史，**看不到 admin 的**
2. 新用户启用 v2free 模板、填自己的账号 → 手动触发 → 成功。用两个不同 v2free 账号交叉验证：A 用户执行时不会用到 B 的凭据
3. 两个用户各配「每天 09:00」→ 各自独立执行，计划时刻互不覆盖
4. 邀请码：用第二次 → 403；过期 → 403；撤销后 → 403
5. 迁移后：admin 的历史记录、凭据、调度配置全部仍在（归属 `user_id=1`）
6. 并发：同一用户的两个账号不并发；全局在飞数不超过 `MAX_CONCURRENT_RUNS`
7. 配额超限 → 记录 `skipped` 且原因在页面可见
8. 现有 `tests/` 下 17 个测试文件全部通过；新增测试：邀请码注册（含并发重放）、用户数据隔离、凭据加密往返、调度器多订阅调度

---

## 10. 未决问题（需你确认后才编码）

1. ~~**§1.2 的语义落差**~~ → **已确认（2026-10-14）**：平台提供模板，用户只能创建模板对应的实例，不能自建模板（D9，落地见 §4.6）
2. 同一用户能否在一个模板下配**多个账号**（如两个 v2free 账号）？契约里 `accounts` 字段已预留，建议支持
3. 配额数值：每用户每日执行次数、interval 下限、每用户订阅数上限
4. 注册后直接登录（体验连续）还是跳登录页（更保守）？建议直接登录
5. 要不要新增 `/admin` 平台概览页？
6. 注册页是否写明「管理员在技术上可解密你的凭据」？建议写明

---

## 11. 实施阶段划分（确认后按此推进）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P1 数据层 | v3 迁移、`store.mjs` 全部接口加用户维度、凭据加密模块 | 无 |
| P2 执行与调度 | `secretsLoader` 注入、调度器遍历订阅 × 账号、并发闸门与配额 | P1 |
| P3 页面与路由 | `status.mjs` 加用户维度 → 6 个页面 → API 过滤 | P1 |
| P4 邀请码与注册 | `invites` 表 CRUD、`/register`、限速、admin 邀请码管理页 | P1 |
| P5 迁移与测试 | 凭据与历史回填、新增测试、全量回归 | P1–P4 |
