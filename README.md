# WeAuto

通用自动化任务平台：**常驻服务 + Web 界面 + 内置调度**。
平台提供任务模板（`tasks/*.mjs`），用户建自己的**任务**——填自己的账号密码、配自己的时间、看自己的执行结果。

> v1 是「被动 CLI + 调度交给 WeMonitor `/cron`」的形态，**已于 2026-10-14 废弃**。
> 现状以 [`docs/功能规格/weauto.md`](docs/功能规格/weauto.md) 为准，「为什么这么设计」见
> [`docs/requirements/`](docs/requirements/)。
> CLI 与 age 加密的旧路径仍在仓库里，仅用于手工调试与旧凭据迁移，见文末「历史」小节。

---

## 它是什么

- **模板只能由平台提供**：`tasks/` 里放一个 `.mjs` 就是一个模板，用户只能创建模板的**实例**（任务），
  不能创建模板。这是安全边界，不是「暂时没做」。
- **一个任务跑一个账号**：想跑第二个账号就再建一个任务。
- **看与建是两步**：`/tasks` 顶部是模板轨道，点一张卡只是进模板页看说明，再点「创建任务」才会真的建。
- **凭据没有独立页面**：在任务页（`/tasks/:id`）的账号区填，就近填写，列表会给「待填凭据」打标。
- **注册走邀请码**：默认只接受邀请链接（管理员在 `/admin/users` 生成，默认单次使用、7 天过期、可撤销），
  首个管理员走 `/setup`。

| 职责 | 归属 |
|---|---|
| 任务怎么执行：模板注册表、凭据解密、HTTP 执行、执行记录 | **WeAuto** |
| 何时执行、Web 展示与手动触发 | **WeAuto 自带**（不再是 WeMonitor） |
| 进程是否活着 | WeMonitor（TCP 探活） |

运行时依赖：`better-sqlite3`、`express`、`jsonwebtoken`、`bcryptjs`。

---

## 快速开始

```bash
npm install

# better-sqlite3 编译于 Node 20（ABI 115），用默认的 Node 24 会报 ABI 不匹配
export PATH="$HOME/.nvm/versions/node/v20.18.3/bin:$PATH"

npm start          # → http://127.0.0.1:18991
```

首次打开会跳 `/setup`：建第一个管理员账号。之后新用户由管理员发邀请链接
（`/register?code=xxx`）自行注册，注册成功即登录。

接着在 `/tasks` 顶部的模板轨道挑一个模板 → 进模板页看清它要填什么 → 「创建任务」→
在任务页填凭据、配调度 → 启动。

---

## 页面

| 路由 | 说明 |
|---|---|
| `/` | 概览：今日成败、需要处理、最近执行 |
| `/tasks` | 任务列表：顶部模板轨道，下面是我的任务，每行可直接**立即执行 / 启动 / 停止 / 配置** |
| `/templates/:name` | 模板页：这个模板是什么、默认调度、要填哪些字段 + 「创建任务」 |
| `/tasks/:id` | 任务页 = 详情 + 配置：结果 → 调度 → 账号密码 → 执行历史 |
| `/admin` `/admin/users` | 管理：平台统计；账号（停用/启用/删除）与邀请码 |
| `/register` `/setup` `/login` | 邀请注册、首次建管理员、登录 |

只有两层内容页：列表上能做完最常用的操作，点标题进任务页，没有第三层。

---

## 新增一个任务模板

在 `tasks/` 放一个 `.mjs` 文件导出模板对象即可，**无需改动任何框架代码**：

```js
export default {
  name: 'my-task',
  displayName: '我的任务',
  requires: ['MY_TOKEN'],                        // 解密后校验这些字段存在
  accounts: false,                               // true = 允许为这个模板建多个任务
  visibility: 'public',                          // 'internal' = 只有 admin 可见（对其它人返回 404）
  schedule: { window: { start: '09:00', end: '09:50' } },   // 北京时间，可省略

  async run({ secrets, account, request, CookieJar, log, now }) {
    // status: success | already-signed | failed | blocked | network-error | config-error
    return { status: 'success', message: '完成', data: {} };
  },
};
```

凭据只能在本机抓取时，模板可以声明 `credentialHelper`（下载脚本 + 命令 + 说明），
页面会把「下一步该做什么」渲染在凭据输入框上方；下载路由只认模板声明过的文件名。

---

## 凭据安全

每个用户的凭据用 **AES-256-GCM** 加密后落在 `user_secrets` 表，主密钥在 `data/master-key`（权限 600）。
页面上只显示字段名与「已设置 / 未设置」，**值永不出现在页面上与 API 响应里**。

**威胁模型（不要夸大）**：防的是数据库文件或备份泄露，**不防主机被入侵**——
主密钥就在服务器上，**管理员技术上可以解密所有人的凭据**，注册页与凭据页都写明了这一点。

因为任务要无人值守地自动执行，解密密钥**必须**存在于运行机器上。加密保护的是
「凭据在传输与存储链路上不被顺走」，不是「机器沦陷后仍安全」。

---

## 调度与执行

调度器每 30 秒一跳，遍历「启动中的任务」，每个任务独立判断：

- 时间取 `effectiveSchedule`（任务里配了就用我的，没配用模板默认）
- **幂等**：window 类当天已成功则跳过，once 类已执行过则跳过
- **单用户串行**：同一用户同时只跑一个任务
- **全局并发上限 4**、**每用户每天 100 次**（手动触发也计入），超限写一条 `skipped` 并写明原因

**随机偏移**：不在任务里 `sleep`，而是用「任务名 + 日期」做种子的哈希算出当日固定目标时刻，
未到点直接退出——不阻塞进程、当天恒定（天然幂等）、被中断后下次触发可自愈、给定日期可预测（可测试）。

| 状态 | 含义 |
|---|---|
| `success` / `already-signed` | 成功 / 目标已达成 |
| `skipped` | 未到点、已完成或配额超限 |
| `failed` / `blocked` / `network-error` / `config-error` | 业务失败 / 被风控 / 超时异常 / 凭据缺失或解密失败 |

---

## 配置

环境变量优先，其次读 `data/.env`。

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEAUTO_PORT` | `18991` | 监听端口 |
| `WEAUTO_HOST` | `0.0.0.0` | 监听地址 |
| `WEAUTO_PUBLIC_URL` | 按请求 Host 拼 | 生成邀请链接时用 |
| `WEAUTO_INVITE_ONLY` | `1` | 置 `0` 变成开放注册，默认只接受邀请码 |
| `WEAUTO_TOKEN_TTL` | `7d` | 会话有效期 |
| `WEAUTO_JWT_SECRET` / `WEAUTO_MASTER_KEY` | 生成到 `data/` | 会话签名与凭据主密钥，均 600 |

`data/` 下有 `weauto.db`、`jwt-secret`、`master-key`、`.env`，**部署时被 rsync 排除**，不会被覆盖。

---

## 部署（N150）

```
git push (main) → GitHub Actions → Release: weauto.tar.gz（不含 node_modules）
  → 上传到 Cloudflare R2（dl.sherlockguo.com）
  → webhook / cron → deploy-agent → rsync 到 ~/weauto/ → restart.sh
```

- 端口 **18991**，域名 `weauto.sherlockguo.com`（Cloudflare Tunnel，路由在 CF Dashboard 配置，
  **禁止改 `config.yml` 的 ingress**）
- 依赖由 `restart.sh` 现场装到 `~/weauto-deps`（npmmirror 源），再软链回 `~/weauto/node_modules`——
  部署目录每轮被 `rsync --delete` 清空，放在里面会被删
- `restart.sh` 带 flock 部署锁，拉起服务时必须 `9>&-`，否则常驻进程继承锁文件描述符会造成死锁
- 服务崩溃由 cron 健康检查在 1 分钟内自愈，**不要手动重启**

---

## 测试

```bash
export PATH="$HOME/.nvm/versions/node/v20.18.3/bin:$PATH"
npm test        # node --test tests/*.test.mjs，22 个文件
```

CI 在打包之前跑测试，不过就不发 Release。覆盖：迁移与 schema、多租户隔离、凭据加密往返、
邀请码四类失效与并发重放、执行器配额与幂等、调度循环、服务端边界（未登录 / 转义 / CSRF / 删号）、
模板契约校验、页面解析（基于真实页面快照）。

取舍：不追覆盖率数字，只测「错了不会报错、只会静默出错」的地方——隔离、幂等、配额、解析都属于这一类。

---

## 目录结构

```
bin/weauto-serve.mjs      常驻服务入口（组件装配都在这里）
bin/weauto.mjs            CLI 入口（历史路径，仅手工调试）
src/
  config.mjs              运行期配置：端口、JWT secret、主密钥、TENANT_LIMITS
  db.mjs                  SQLite 连接与迁移（v1–v4，只追加不改）
  store.mjs               数据访问层（只提供绑定用户的视图 forUser）
  user-secrets.mjs        每用户凭据加密（AES-256-GCM）
  invites.mjs             邀请码的生成、校验、消耗
  scheduler.mjs           调度器（管时间）
  executor.mjs            执行器（管安全：幂等、配额、凭据、超时、记录）
  status.mjs              状态推导（不存状态，每次算）
  registry.mjs            扫描 tasks/ 加载模板
  schedule.mjs            种子化随机调度 + effectiveSchedule
  server.mjs               HTTP 路由与页面
  render.mjs              服务端直出 HTML
  auth/                    账号（users / password / token）
  credentials.mjs http.mjs history.mjs lock.mjs pairing.mjs runner.mjs
  secrets.mjs task-contract.mjs format.mjs util.mjs
tasks/                     模板：v2free-checkin.mjs、workbuddy-checkin.mjs
scripts/                   probe.mjs、import-runs.mjs 等一次性脚本
public/                    app.js（前端交互）、style.css
tests/                     node:test，22 个文件（fixtures/ 放真实页面快照）
data/                      weauto.db、jwt-secret、master-key、.env（已 gitignore）
```

---

## 历史：v1 被动 CLI 与 age 加密

2026-10-13 的 v1 是**被动 CLI**：WeAuto 不负责调度，由 WeMonitor 的 `/cron` 页面用
`*/5 9 * * *` 高频触发 `bin/weauto.mjs run <task>`，任务自己判断有没有到点，结果写 `data/runs.jsonl`，
再由 WeMonitor 的 `/auto` 页面展示。**该项目形态没有常驻进程、没有端口。**

它带来的问题是每次执行都要重新装一遍上下文，且展示与执行分在两个仓库。2026-10-14 起改为
常驻服务（v2 独立化 → v3 多租户），调度、展示、凭据全部收进 WeAuto，WeMonitor 只保留 TCP 探活。

仍然保留的东西：

- **`bin/weauto.mjs run / list / status`**：仍走老的 JSONL 路径，不再被调度使用，仅用于手工调试。
- **age 与 `secrets.age`**：v1 的凭据用 age 加密（密文入 Git、私钥 `~/.age/weauto.key` 不入 Git）。
  现在每用户凭据是 AES-256-GCM + 主密钥，**age 只用于迁移旧凭据**。
  如果还要走这条路径，私钥是唯一单点：它不在 Git 里、不随发布包分发，
  只存在于开发机与运行机上，两台机器同时损毁＝凭据永久丢失，需要一份脱离这两台机器的备份。
