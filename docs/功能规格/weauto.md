# WeAuto — 功能规格

> 状态：已实现（多租户版，2026-10-15）
> 本文件描述**现在**怎么工作，是修改本模块前的必读项，需随实现变化同步更新。
> 「**为什么**这么设计」（方案对比、废弃方案、实测修正）见
> [需求文档](../requirements/weauto-multi-tenant.md)（v3 多租户）与
> [独立化需求](../requirements/weauto-standalone.md)（v2 服务化）。

---

## 1. 系统边界

WeAuto 是一个**常驻 HTTP 服务 + Web 界面**的自动化任务平台，自带调度器，不依赖外部 cron。

**产品形态**：平台提供任务模板（`tasks/*.mjs`），用户启用模板得到自己的**实例**（订阅），
配自己的账号凭据与执行时间。**用户能建实例，不能建模板**——模板只能由平台通过代码提供。

**只有两层页面**：任务列表（`/tasks`）是操作起点——每行自带「立即执行 / 停用 / 配置」，
最常用的事在这一层就能做完；点标题或齿轮进任务页（`/tasks/:name`），
那里是**详情 + 配置合并**的一页：结果 → 调度 → 账号 → 执行历史。不再有第三层。

**凭据没有独立页面**：凭据在任务页里填（`/tasks/:name` 的「我的账号」区），
账号的增删停用也在那里。列表会给「待填凭据」打标，用来替代「集中看哪些没填」的需求。

| 职责 | 归属 |
|---|---|
| 任务怎么执行：模板注册表、凭据解密、HTTP 执行、执行记录 | **WeAuto** |
| 何时执行、Web 展示与手动触发 | **WeAuto 自带**（不再是 WeMonitor） |
| 进程是否活着 | WeMonitor（TCP 探活） |

运行时依赖：`better-sqlite3`、`jsonwebtoken`、`express`；凭据解密的 `age` 只用于**迁移旧凭据**。

---

## 2. 目录结构

```
bin/weauto-serve.mjs      常驻服务入口（组件装配都在这里）
bin/weauto.mjs            CLI 入口（run / list / status，历史路径）
src/
  config.mjs              运行期配置：端口、JWT secret、主密钥、TENANT_LIMITS
  db.mjs                  SQLite 连接与迁移（v1–v4，只追加不改）
  bootstrap.mjs           启动期回填：旧数据归入第一个账号
  store.mjs               数据访问层（**只提供绑定用户的视图** forUser）
  user-secrets.mjs        每用户凭据加密（AES-256-GCM）
  invites.mjs             邀请码的生成、校验、消耗
  scheduler.mjs           调度器（管时间）
  executor.mjs            执行器（管安全：幂等、配额、凭据、超时、记录）
  status.mjs              状态推导（不存状态，每次算）
  registry.mjs            扫描 tasks/ 加载模板
  runner.mjs              CLI 执行路径（写 JSONL，与 Web 路径并存）
  schedule.mjs            种子化随机调度 + effectiveSchedule
  server.mjs              HTTP 路由与页面
  render.mjs              服务端直出 HTML
  auth/                   账号（users / password / token）
tasks/v2free-checkin.mjs  v2free 签到模板
scripts/                  probe.mjs、import-runs.mjs 等一次性脚本
public/                   app.js（前端交互）、style.css
tests/                    node:test，20 个文件
data/                     weauto.db、jwt-secret、master-key、.env（已 gitignore）
```

---

## 3. 数据模型（schema 版本 4）

```
users ──┬── subscriptions ── subscription_accounts
        ├── user_secrets（每用户加密凭据）
        ├── invites（created_by / used_by）
        └── runs ── run_logs

task_state（按 用户 × 模板 × 账号）
run_stats_daily（按 用户 × 模板 × 日期）
```

| 表 | 关键约束 | 说明 |
|---|---|---|
| `users` | `session_epoch` | 会话版本号，注销/改密 +1 |
| `subscriptions` | `UNIQUE(user_id, task_name)` | 一个用户对一个模板只有一个实例 |
| `subscription_accounts` | `UNIQUE(subscription_id, account_key)` | 多账号模板才有多行；单账号模板只有 `account_key=''` 一条 |
| `user_secrets` | `PK(user_id, task_name, account_key, field)` | 密文 `value_enc = iv ‖ tag ‖ ciphertext` |
| `runs` | `user_id DEFAULT 1`、`account_key` | 幂等按「用户 × 模板 × 账号 × 日期」 |
| `task_state` | `PK(user_id, task_name, account_key)` | 今日目标时刻，重启后不变 |

迁移约定：**只追加，不改已发布的迁移**。v3 把历史数据归入 `user_id=1`，v4 加会话版本号。

### 3.1 隔离是怎么保证的

`createStore(db)` 只对外暴露 `forUser(userId)`——**没有「不带用户」的入口**，
所以「忘了过滤 `user_id`」在结构上不可能发生。全局只留四个跨用户方法：
`forUser` / `allSubscriptions` / `allUserIds` / `purgeUser`，以及 `/admin` 用的只读统计。

---

## 4. 账号与登录

- **注册**：默认只接受邀请码（`WEAUTO_INVITE_ONLY=0` 可开放）。管理员在**账号管理页**
  （`/admin/users`）生成邀请链接，默认单次使用、7 天过期，可撤销。注册时角色固定 `user`，
  注册成功即登录。
- **会话**：HttpOnly Cookie + JWT（默认 7 天）。token 里带 `se`（会话版本号），
  **每次请求都回查 `users`**：停用、注销、改密后立即失效，不等 token 过期。
- **权限**：`user` 能管自己的订阅、凭据、调度；`admin` 额外能发邀请码、管账号、看 `/admin`。
- **管理员不代建账号**：账号一律由本人凭邀请链接在 `/register` 自建（首个管理员走 `/setup`）。
  管理页没有新建账号表单，`POST /api/users` 也不存在——管理员不该知道/代填别人的初始密码。
  需要管理员时，先让他注册成普通用户，再由管理员用 `PATCH /api/users/:id` 改角色。
- **账号管理只在 `/admin/users`**：设置（右上角头像展开的弹层）只放个人偏好（外观）、
  只读信息（系统）与退出登录，不再放「管理」入口——管理员导航里已有「管理」页（`/admin`），
  两处入口重复，且这是个人弹层，不该掺平台级操作。账号管理是平台级操作，和个人设置混在一起时，
  「为什么我能在这里停用自己的账号」这类问题会一直出现。
- **设置不是一个页面**：底部导航只有「概览 / 任务」（+ 管理员的「管理」），
  设置从右上角头像 + 用户名展开——它只有两项内容，占一个底部 tab 会让用户以为里面还有别的东西。
  代价：打开依赖 JS（按钮没有 href 可去），主题切换本来就依赖 JS，所以不是能力退化。
- **对自己不渲染停用与删除**：`PATCH /api/users/:id` 拒绝停用自己、拒绝改自己的角色
  （唯一管理员把自己降成 `user` 后就再也进不了管理页，只能改数据库）；页面同样不渲染按钮，
  免得「点了才报错」。

---

## 5. 凭据

| 项 | 现状 |
|---|---|
| 存储 | `user_secrets` 表，AES-256-GCM，主密钥在 `data/master-key`（600，首次生成） |
| 粒度 | 用户 × 模板 × 账号 × 字段 |
| 写入 | 只能写模板 `requires` 声明过的字段（白名单） |
| 界面 | 只显示字段名与「已设置 / 未设置」，值永不出现在页面上与 API 响应里 |

**威胁模型（不要夸大）**：防的是数据库文件或备份泄露，**不防主机被入侵**。
主密钥就在服务器上，**管理员技术上可以解密所有人的凭据**——注册页与凭据页都写明了这一点。

迁移自旧的 `secrets.age`（age 加密、全站一份）：启动时由 `bootstrap.mjs` 读入并加密到
`user_id=1` 名下，只做一次（用 `meta.tenant_bootstrap_v3` 标记），原文件保留作回滚依据。

---

## 6. 模板契约

在 `tasks/` 放一个 `.mjs` 文件导出模板对象即可，无需改框架代码：

```js
export default {
  name: 'my-task',
  displayName: '我的任务',
  requires: ['MY_TOKEN'],     // 解密后校验这些字段存在
  accounts: false,            // true = 允许用户在同一实例下配多个账号
  visibility: 'public',       // 'internal' = 只有 admin 可见可启用
  schedule: { window: { start: '09:00', end: '09:50' } },
  async run({ secrets, account, request, CookieJar, log, now }) {
    return { status: 'success', message: '完成', data: {} };
  },
};
```

`visibility: 'internal'` 的模板对非 admin 返回 **404 而不是 403**——403 会证实它存在，
等于把 internal 清单泄露出去。

---

## 7. 状态

| 状态 | 含义 | 计入「今日已完成」 |
|---|---|---|
| `success` | 执行成功 | ✅ |
| `already-signed` | 目标已达成（如服务端提示今日已签到） | ✅ |
| `skipped` | 未到点 / 已完成 / 配额超限 | — |
| `failed` | 业务失败 | ❌ |
| `blocked` | 响应非预期、被风控 | ❌ |
| `network-error` | 超时或任务抛异常 | ❌ |
| `config-error` | 凭据缺字段或解密失败 | ❌ |

---

## 8. 调度与执行

**调度器**（每 30 秒一跳）遍历「订阅 × 启用中的账号」，每个目标独立判断：

- 用 `effectiveSchedule` 取「用户在订阅里配的时间」，配了就用用户的，没配用模板默认
- 幂等：window 类当天该账号已成功则跳过；once 类已被调度执行过则跳过
- **单用户串行**：同一用户同时只跑一个任务
- **全局并发上限 4**（`TENANT_LIMITS.maxConcurrent`）
- **配额**：每用户每天 100 次（手动触发也计入），超限写一条 `skipped` 并写明原因
- 停用的用户、停用的订阅、已下线的模板都不进入调度目标

**执行器**负责：幂等 → 配额 → 取该用户该账号的凭据 → 跑（任务自带的 `timeoutMs` 超时）→
落库 `{ runs, run_logs }`。执行抛异常不会让调度器停摆。

**调度算法**：`seed = sha256(taskName:date)`，目标时刻落在窗口内，每天不同。

---

## 9. 页面与接口

| 路由 | 说明 | 权限 |
|---|---|---|
| `/` | 概览：今日成败统计、需要处理、最近执行 | 登录 |
| `/tasks` | 任务列表：**每行可直接立即执行 / 停用 / 配置**，下方是「可以启用的模板」 | 登录 |
| `/tasks/:name` | 任务页 = 详情 + 配置：结果 → 调度（可改）→ **这个任务的账号密码**（就近填写、加/删/停用账号）→ 执行历史 | 登录 |
| `/tasks/:name/config` | 已并入任务页，302 到 `/tasks/:name`（保留 account 参数） | 登录 |
| `/credentials` | 已取消，302 到 `/tasks` | 登录 |
| `/settings` | 已取消：内容搬进右上角头像展开的弹层（骨架的一部分，每页都在），302 到 `/` | 登录 |
| `/admin` | 管理首页：账号数、启用实例、今日成败、失败排行 + 管理入口 | admin |
| `/admin/users` | 账号管理：账号列表（停用/启用、删除）、邀请码；**不提供新建账号** | admin |
| `/login` `/setup` `/logout` `/register` | 登录、首次建管理员、注销、邀请注册 | 公开 |
| `/healthz` | 探活（不鉴权，只报平台级信息） | 公开 |
| `/api/*` | 见源码，全部按 `req.user.id` 过滤 | 登录 |

写操作有 CSRF 保护（非同源拒绝）；登录与注册有按 IP 的失败限速。

---

## 10. 部署

```
git push (main) → GitHub Actions → Release: weauto.tar.gz
  → webhook / cron → deploy-agent → rsync 到 ~/weauto/ → restart.sh
```

- 端口 **18991**，域名 `weauto.sherlockguo.com`（Cloudflare Tunnel，路由在 CF Dashboard 配置，
  **禁止改 `config.yml` 的 ingress**）
- `restart.sh` 需带 flock（且子进程要 `9>&-`，否则锁被继承造成死锁）
- `data/` 与 `.env` 被 rsync 排除：数据库、JWT secret、主密钥都不会被部署覆盖

**升级到多租户后**：所有已登录用户需要重新登录一次（v4 迁移让旧 token 失效）。

---

## 11. 已知限制

1. **多账号的批量操作没有入口**——例如「全部账号立即执行一次」。
   单个账号可以单独停用/启用，但一次性操作只能逐个来。
2. **出口 IP 只有一个**（N150）。所有人的请求都从这里出，目标站若做同 IP 风控会连坐。
3. **未实现 TOTP**——v2free 账号未开两步验证；如开启需在任务内补约 25 行 TOTP 生成。
4. **`v2free-checkin` 依赖页面结构**——账户数据解析自页面内嵌的 `crispSessionData`，
   站点改版会导致 `data.remainTraffic` 为 null。
5. **凭据加密不防主机入侵**——主密钥在服务器上，这是自建部署的固有性质。
6. **`runs.jsonl` 与 CLI 路径并存**——`bin/weauto.mjs run` 仍走老的 JSONL 路径，
   不再被调度使用，仅用于手工调试。
7. **每次执行都重新登录 v2free**——Cookie 仅 1 小时有效，`remember_me` 实测无效。

---

## 12. 测试

```bash
npm test        # node --test tests/*.test.mjs
```

注意：本机 `better-sqlite3` 编译于 Node 20，直接用默认的 Node 24 会报 ABI 不匹配，
跑测试前需 `export PATH="$HOME/.nvm/versions/node/v20.18.3/bin:$PATH"`。

| 文件 | 覆盖 |
|---|---|
| `db.test.mjs` | 迁移（只追加）、schema 演进 |
| `store.test.mjs` | 订阅与账号 CRUD、**多租户隔离**、资源上限、保留策略 |
| `user-secrets.test.mjs` | 加密往返、篡改与错密钥、用户间不可见 |
| `invites.test.mjs` | 生成、四类失效、并发重放、参数上限 |
| `executor.test.mjs` | 幂等按账号、配额、凭据缺失与错密钥 |
| `scheduler.test.mjs` | 调度循环、订阅里的时间生效、单用户串行、停用用户 |
| `server.test.mjs` | 未登录边界、转义、CSRF、邀请注册、删号、平台页 |
| `auth-*.test.mjs` | 密码哈希、token 签发验签、账号存储 |
| `task-contract.test.mjs` / `registry.test.mjs` | 模板契约校验 |
| `task-v2free.test.mjs` | 页面解析（基于真实快照） |
| `schedule.test.mjs` / `util.test.mjs` / `format.test.mjs` | 时区与调度算法、格式化 |
| `history.test.mjs` / `lock.test.mjs` / `credentials.test.mjs` / `contract.test.mjs` | 历史路径与跨仓库契约 |
