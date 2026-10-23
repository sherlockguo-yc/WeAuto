# WeAuto — 功能规格

> 状态：已实现（多租户版，2026-10-15）
> 本文件描述**现在**怎么工作，是修改本模块前的必读项，需随实现变化同步更新。
> 「**为什么**这么设计」（方案对比、废弃方案、实测修正）见
> [需求文档](../requirements/weauto-multi-tenant.md)（v3 多租户）与
> [独立化需求](../requirements/weauto-standalone.md)（v2 服务化）。

---

## 1. 系统边界

WeAuto 是一个**常驻 HTTP 服务 + Web 界面**的自动化任务平台，自带调度器，不依赖外部 cron。

**产品形态**：平台提供任务模板（`tasks/*.mjs`），用户在 `/tasks` 顶部的模板轨道点一个模板，
进模板页（`/templates/:name`）看清它要填什么、默认什么时候跑，再点「创建任务」得到属于自己的
**任务**——配自己的账号密码、调度方式和时间。
**一个任务只跑一个账号**：想跑第二个账号就再建一个任务（这也是模板轨道存在的理由）。
**用户能建任务，不能建模板**——模板只能由平台通过代码提供。

**看与建是两步**：点模板卡只是查看（以前点一下就直接建出任务，用户只想看看，
列表里就多了一个没配好的空任务）。

**只有两层内容页**：任务列表（`/tasks`）是操作起点——每行自带「立即执行 / 停止 / 配置」，
最常用的事在这一层就能做完；点标题进任务页（`/tasks/:id`），
那里是**详情 + 配置合并**的一页：结果 → 调度 → 账号密码 → 执行历史。不再有第三层。
模板页是旁路的一屏，不参与这个层级。

**凭据没有独立页面**：凭据在任务页里填（`/tasks/:name` 的「我的账号」区），
账号的增删停用也在那里。列表会给「待填凭据」打标，用来替代「集中看哪些没填」的需求。

| 职责 | 归属 |
|---|---|
| 任务怎么执行：模板注册表、凭据解密、HTTP 执行、执行记录 | **WeAuto** |
| 何时执行、Web 展示与手动触发 | **WeAuto 自带**（不再是 WeMonitor） |
| 进程是否活着 | WeMonitor（TCP 探活） |

运行时依赖：`better-sqlite3`、`express`、`jsonwebtoken`、`bcryptjs`（密码哈希，cost=12）。
凭据解密的 `age` 只用于**迁移 v1 的旧凭据**（见 §5）。

---

## 2. 目录结构

```
bin/weauto-serve.mjs      常驻服务入口（组件装配都在这里）
bin/weauto.mjs            CLI 入口（run / list / status，历史路径）
src/
  config.mjs              运行期配置：端口、JWT secret、主密钥、TENANT_LIMITS
  db.mjs                  SQLite 连接与迁移（v1–v5，只追加不改）
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
  task-contract.mjs       模板契约校验（加载期拒绝不合规的声明）
  pairing.mjs             配对码：本机脚本把凭据推回服务端的备用通道
  credentials.mjs         凭据字段的读写与「已设置 / 未设置」视图
  format.mjs              结果视图渲染（只认任务声明的 view）
  http.mjs                CookieJar + fetch 封装
  history.mjs             runs.jsonl 读写（CLI 路径，仅手工调试）
  lock.mjs                进程锁（陈旧判定 + 年龄兜底）
  runner.mjs              CLI 执行路径（写 JSONL，与 Web 路径并存）
  secrets.mjs             age 解密（只用于迁移 v1 的旧凭据）
  util.mjs                路径常量、dotenv 解析、时区计算
  auth/                   账号（users / password / token）
tasks/                    模板：v2free-checkin.mjs、workbuddy-checkin.mjs
scripts/                  probe.mjs、import-runs.mjs 等一次性脚本
public/                   app.js（前端交互）、style.css
tests/                    node:test，23 个文件（fixtures/ 放真实页面快照）
data/                     weauto.db、jwt-secret、master-key、.env（已 gitignore）
```

---

## 3. 数据模型（schema 版本 5）

```
users ──┬── subscriptions（一行 = 一个任务）
        ├── user_secrets（每用户加密凭据）
        ├── invites（created_by / used_by）
        └── runs ── run_logs

task_state（按 用户 × 模板 × 账号）
run_stats_daily（按 用户 × 模板 × 日期）
```

| 表 | 关键约束 | 说明 |
|---|---|---|
| `users` | `session_epoch` | 会话版本号，注销/改密 +1 |
| `subscriptions` | `UNIQUE(user_id, task_name, account_key)` | **一行就是一个任务**：谁的任务、哪个模板、跑哪个账号、启停、调度、超时。表名沿用建表时的叫法，产品语言里叫「任务」 |
| `subscription_accounts` | 已废弃（v5 清空不再写入） | 账号维度已并进 `subscriptions.account_key`——一个任务只跑一个账号 |
| `user_secrets` | `PK(user_id, task_name, account_key, field)` | 密文 `value_enc = iv ‖ tag ‖ ciphertext` |
| `runs` | `user_id DEFAULT 1`、`account_key` | 幂等按「用户 × 模板 × 账号 × 日期」 |
| `task_state` | `PK(user_id, task_name, account_key)` | 今日目标时刻，重启后不变 |

迁移约定：**只追加，不改已发布的迁移**。v3 把历史数据归入 `user_id=1`，v4 加会话版本号，
v5 把「订阅 + 账号」两层拍平成「一行一个任务」（SQLite 改不了 UNIQUE，
所以是建新表 → 搬数据 → 删旧表 → 改名，第 2 个及以后的账号各自变成一条任务）。

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
- **权限**：`user` 能管自己的任务、凭据、调度；`admin` 额外能发邀请码、管账号、看 `/admin`。
- **管理员不代建账号**：账号一律由本人凭邀请链接在 `/register` 自建（首个管理员走 `/setup`）。
  管理页没有新建账号表单，`POST /api/users` 也不存在——管理员不该知道/代填别人的初始密码。
  需要管理员时，先让他注册成普通用户，再由管理员用 `PATCH /api/users/:id` 改角色。
- **账号管理只在 `/admin/users`**：设置（右上角头像展开的弹层）只放个人偏好（外观）、
  只读信息（系统）与退出登录，不再放「管理」入口——管理员导航里已有「管理」页（`/admin`），
  两处入口重复，且这是个人弹层，不该掺平台级操作。账号管理是平台级操作，和个人设置混在一起时，
  「为什么我能在这里停用自己的账号」这类问题会一直出现。
- **设置不是一个页面**：底部导航只有「概览 / 任务」（+ 管理员的「管理」），
  设置从右上角头像 + 用户名展开——它内容不多，占一个底部 tab 会让用户以为里面还有别的东西。
  代价：打开依赖 JS（按钮没有 href 可去），主题切换本来就依赖 JS，所以不是能力退化。
- **系统信息只留三项**：版本、运行时长、任务模板。它们回答同一个问题——
  「我刚那次部署生效了吗」（版本对不对、是不是刚重启过、`tasks/` 里的文件有没有被加载）。
  已删掉的三项各有毛病：数据目录与数据库文件名只有 SSH 到机器上才用得上，在网页里
  还向普通用户透了服务器路径；「调度器：运行中」是写死的字面量，`scheduler` 没有暴露
  启停状态，调度真停了它照样说运行中——**假状态比没有状态更糟**，所以不显示。
- **对自己不渲染停用与删除**：`PATCH /api/users/:id` 拒绝停用自己、拒绝改自己的角色
  （唯一管理员把自己降成 `user` 后就再也进不了管理页，只能改数据库）；页面同样不渲染按钮，
  免得「点了才报错」。
- **账号备注（`users.note`）**：用户注册时自己起的名字往往是网名（jason、GGBond），
  管理员认不出是谁，所以每个账号可以带一条备注。**只有管理员能读写**，普通用户看不到也改不了，
  因此只出现在 `/admin/users`。写在名字右侧同一行（`jason · 抖音号老张`），
  **点一下就变成输入框**，回车或失焦保存、Esc 放弃、没改动不发请求；没写备注时占位成
  灰色的「＋备注」，否则看不出这里可点。存储时折叠换行与连续空白并截断到 60 字
  （单行展示，留着换行只会在渲染时被压掉）。备注是例外——自己那一行也能改，
  因为它不会锁住任何人。
- **邀请码管理分成两块**：生成区（表单套在浅底容器里，小标题「新建邀请」）与记录区
  （分隔线 + 「邀请记录 N」）分开。两块连在一起时，紧接着表单的第一条记录会被读成表单的第四行。
  记录行只给三样东西：**备注**（主标题，认人的唯一依据；没填就弱化成灰色「（无备注）」）、
  **一行元信息**（`10-19 创建 · 10-25 过期 · 已用 0/1`，`expires_at` 为空写「长期有效」）、
  **状态徽章 + 「复制链接 / 撤销」**；左边缘一条状态色竖条（未使用绿 / 部分使用黄 / 失效灰），
  失效条目淡化文字但保留按钮。
- **注册链接不铺在页面上**：那串 URL 又长又没人读，占掉的视觉重量反而盖过备注，
  只留在「复制链接」按钮的 `data-url` 上，要用时点一下即可。

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

### 5.1 凭据获取引导（credentialHelper）

有些凭据没法"去后台注册一个 key"，只能从用户本机运行的客户端里抓——WorkBuddy 的
`WB_ACCESS_TOKEN` 就是这样：它只存在于桌面客户端进程内存里，磁盘上是加密的。

模板可以在 `credentialHelper` 里声明获取方式，任务页把它渲染在凭据输入框**正上方**：
用户卡在输入框的那一刻，答案就在眼前。

| 字段 | 含义 |
|---|---|
| `download` | `scripts/` 下的文件名，渲染成个性化下载链接（需登录） |
| `command` | 可一键复制的命令 |
| `steps` | 参与编号的补充步骤。**"跑完会怎样"不要写在这里**——那是结果不是动作，会被读成多一步 |
| `note` | 技术备注（依赖、耗时），灰色小字，不编号 |

本机脚本通过 `POST /api/tools/push-token` 把值推回服务器，鉴权靠 `pushToken`
（按任务绑定、长期有效、与普通凭据一样密文存储）。这一步**不能**依赖登录态：
脚本那一侧没有 Cookie。配对码 `pair-code` 是它的备用通道（10 分钟、一次性）。

**平台差异（2026-10-20 实测，不是推测）**：

| | Windows | macOS |
|---|---|---|
| 下载物 | `update-workbuddy-token.cmd`，内嵌服务器地址与 `pushToken` | `grab-workbuddy-token.mjs`，内嵌同样的信息 |
| 执行方式 | **双击即可**（`.cmd` 走文件关联，不需要权限位） | 必须在终端跑一次 `node <文件>` |
| 原因 | — | 浏览器下载不保留执行位：`.command` 权限 644 时双击无反应；用 zip 保住权限后又被 Gatekeeper 隔离标记拦下 |

**客户端怎么找**（`scripts/grab-workbuddy-token.mjs` 的 `findApp`）：
目标是「**不管装在哪都能找到**」，所以分四级，便宜的在前、贵的兜底，命中即停：

1. **系统记录**（一次 PowerShell 调用，~0.5 秒）：运行中的进程路径 → App Paths 注册表项 →
   卸载项的 `DisplayIcon` / `InstallLocation` → 开始菜单与桌面快捷方式。
   客户端正在跑的时候，进程路径是唯一可信的；NSIS / Squirrel 安装器几乎都会写 App Paths。
2. **常见目录 + 一级通配**（毫秒级）：枚举所有存在的盘符，每盘试
   `WorkBuddy` / `Program Files\WorkBuddy` / `Program Files (x86)\WorkBuddy` /
   `Programs\WorkBuddy` / `Apps\WorkBuddy`，再扫各盘**一级目录 × `WorkBuddy`**（覆盖 `D:\Soft\WorkBuddy`）。
3. **递归遍历每个固定盘**（兜底，最多 120 秒，带进度输出）：不限深度，
   跳过 `Windows` / `$Recycle.Bin` / `System Volume Information` / `node_modules` / `Package Cache`，
   不跟符号链接（junction 会成环）。这一层才是「装哪都能找到」的保证。
4. 全都落空才报错，并提示用 `--app` 指定路径。

多份命中时取 **exe 的 mtime 最新**那份（升级后新装的那个）。
这一整套只在 Windows 上跑，所以候选列表、递归扫描、PowerShell 输出的解析都做成可注入的纯函数，
由 `tests/grabber-locate.test.mjs` 在其它平台上钉住（含 PowerShell 模板的反斜杠转义）。

> **WorkBuddy 与 CodeBuddy 是两个产品。** 本项目的 WorkBuddy 任务只允许出现
> `www.workbuddy.cn` 域名。曾误用 CodeBuddy 控制台的 OAuth client 验证授权流程，
> 得到的是另一个产品的登录页、且报"账号不存在"——那次结论作废，教训见 §11.8。

---

## 6. 模板契约

在 `tasks/` 放一个 `.mjs` 文件导出模板对象即可，无需改框架代码：

```js
export default {
  name: 'my-task',
  displayName: '我的任务',
  requires: ['MY_TOKEN'],     // 解密后校验这些字段存在
  accounts: false,            // true = 允许为这个模板建多个任务（一个任务一个账号）
  visibility: 'public',       // 'internal' = 只有 admin 可见可启用
  schedule: { window: { start: '09:00', end: '09:50' } },
  // 可选：凭据只能在用户本机抓时，声明怎么抓（渲染在凭据输入框上方，见 §5.1）
  credentialHelper: {
    download: 'grab-workbuddy-token.mjs',
    command: 'node grab-workbuddy-token.mjs',
    note: '需要 Node 18+。',
  },
  async run({ secrets, account, request, CookieJar, log, now }) {
    return { status: 'success', message: '完成', data: {} };
  },
};
```

`visibility: 'internal'` 的模板对非 admin 返回 **404 而不是 403**——403 会证实它存在，
等于把 internal 清单泄露出去。

`credentialHelper.download` 只接受 `^[a-z0-9][a-z0-9-]*\.mjs$`：同一份正则同时挡住路径穿越
和"把 `/etc/passwd` 声明成脚本"。下载路由另外只认模板声明过的文件名（白名单），不扫目录。

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

上表是**执行结果**（写进 `runs`）。页面上的「今日状态」是**推导出来的**（`status.mjs`，不存库），
取值比这张表多四个：

| 今日状态 | 含义 |
|---|---|
| `pending` | 还没到点，等着 |
| `disabled` | 任务被停用了 |
| `manual` | 没配调度，只能手动触发 |
| `missed` | **窗口已过 / 计划时刻已过且未执行**——今天不会再自动跑成，标「待执行」就是在骗人，所以单列一项并计入「需要处理」 |

调度器**不写「跳过」记录**：每 30 秒写一条「窗口已过」会瞬间淹掉执行历史，
这些状态全由「计划 + 实际记录」现算。

---

## 8. 调度与执行

**调度器**（每 30 秒一跳）遍历「启动中的任务」，每个任务独立判断：

- 用 `effectiveSchedule` 取「我在任务里配的时间」，配了就用我的，没配用模板默认
- 幂等：window 类当天已成功则跳过；once 类已被调度执行过则跳过
- **单用户串行**：同一用户同时只跑一个任务
- **全局并发上限 4**（`TENANT_LIMITS.maxConcurrent`）
- **配额**：每用户每天 100 次（手动触发也计入），超限写一条 `skipped` 并写明原因
- **上限**（`TENANT_LIMITS`，运营参数集中在一处、由装配层注入，**各模块自己不读环境变量**）：
  每用户最多 20 个任务、间隔任务的最小间隔 5 分钟
- 停用的用户、**停止状态的任务**、已下线的模板都不进入调度目标

**执行器**负责：幂等 → 配额 → 取该用户该账号的凭据 → 跑（任务自带的 `timeoutMs` 超时）→
落库 `{ runs, run_logs }`。执行抛异常不会让调度器停摆。

**调度算法**：`seed = sha256(taskName:date)`，目标时刻落在窗口内，每天不同。

---

## 9. 页面与接口

| 路由 | 说明 | 权限 |
|---|---|---|
| `/` | 概览：今日成败统计、需要处理、最近执行 | 登录 |
| `/tasks` | 任务列表：顶部是**模板轨道**（点一张卡进模板页），下面是我的任务，**每行可直接立即执行 / 启动 / 停止 / 配置** | 登录 |
| `/templates/:name` | 模板页：这个模板是什么、默认调度、要填哪些字段 + 「创建任务」按钮 + 我用它建过的任务。不存在或 internal（非 admin）返回 404 | 登录 |
| `/tasks/:id` | 任务页 = 详情 + 配置：结果 → 调度（可改）→ **这个任务的账号密码**（就近填写）→ 执行历史，另有「删除任务」 | 登录 |
| `/credentials` | 已取消，302 到 `/tasks` | 登录 |
| `/settings` | 已取消：内容搬进右上角头像展开的弹层（骨架的一部分，每页都在），302 到 `/` | 登录 |
| `/admin` | 管理首页：账号数、启动中的任务、今日成败、失败排行 + 管理入口 | admin |
| `/admin/users` | 账号管理：账号列表（备注、停用/启用、删除）、邀请码（生成区 + 邀请记录）；**不提供新建账号** | admin |
| `/login` `/setup` `/logout` `/register` | 登录、首次建管理员、注销、邀请注册 | 公开 |
| `/healthz` | 探活（不鉴权，只报平台级信息） | 公开 |
| `/api/*` | 见源码，全部按 `req.user.id` 过滤 | 登录 |

写操作有 CSRF 保护（非同源拒绝）；登录与注册有按 IP 的失败限速。

**本机脚本的通道不走页面**：`GET /api/tools/:file` 下载凭据抓取脚本（只认模板声明过的文件名，
不扫目录），`POST /api/tools/push-token` 接收脚本推回的凭据——它靠按任务绑定的 `pushToken` 鉴权，
**不能依赖登录态**（脚本那一侧没有 Cookie）；`/api/tasks/:id/pair-code` 与 `/pair-status`
是同一件事的备用配对通道（10 分钟、一次性）。背景见 §5.1。

**破坏性操作不用 `window.confirm`**：删除任务、撤销邀请码、删除账号都走 `askConfirm()`
（`public/app.js`）——原生 `<dialog>` + `showModal()`，宽屏居中一张小卡、窄屏转底部抽屉，
标题带上对象名（「删除任务「签到」？」），确认按钮实心红、取消是描边幽灵按钮。
Esc 关闭、点遮罩关闭、Tab 留在框内、关闭后焦点还给原按钮，都是 `<dialog>` 或几行 JS 保证的。
理由：原生弹窗是浏览器样式，和这套配色对不上；更要紧的是它塞不进「删的是哪一个」——
而那恰恰是按下之前最该看清的一行字。

---

## 10. 部署

```
git push (main) → GitHub Actions → Release: weauto.tar.gz（只含源码，不含 node_modules）
  → 上传到 Cloudflare R2（dl.sherlockguo.com）
  → webhook / cron → deploy-agent → rsync 到 ~/weauto/ → restart.sh
```

- 包里**不含 `node_modules`**：带依赖的包 7.1MB 而 N150 出境到 GitHub 只有几 KB/s，
  现在依赖由 `restart.sh` 从 npmmirror 装到 `~/weauto-deps` 并软链回部署目录
  （部署目录每轮被 `rsync --delete` 清空，放在里面会被删）
- 端口 **18991**，域名 `weauto.sherlockguo.com`（Cloudflare Tunnel，路由在 CF Dashboard 配置，
  **禁止改 `config.yml` 的 ingress**）
- `restart.sh` 需带 flock（且子进程要 `9>&-`，否则锁被继承造成死锁）
- `data/` 与 `.env` 被 rsync 排除：数据库、JWT secret、主密钥都不会被部署覆盖

**升级到多租户后**：所有已登录用户需要重新登录一次（v4 迁移让旧 token 失效）。

---

## 11. 已知限制

1. **同一个模板建的多个任务没有批量操作入口**——例如「全部立即执行一次」。
   一个任务只跑一个账号，要跑第二个账号就再建一个任务，一次性操作只能逐个来。
2. **出口 IP 只有一个**（N150）。所有人的请求都从这里出，目标站若做同 IP 风控会连坐。
   实测出口有两条：IPv6 `2409:8a55:2ebb:e581::/64`（临时地址每 24h 轮换，前缀稳定，
   是 v2free 这类 CF 站点实际看到的地址）与 IPv4 `120.229.47.53`（中国移动深圳家宽，
   动态分配，非 CGNAT）。
   现有缓解手段（都不能替代换 IP）：
   - 调度种子含 `accountKey`，同模板多账号落在窗口内不同时刻
   - `request()` 对同一域名强制 1~3 秒间隔
   - UA 按账号从 8 个真实浏览器 UA 中固定选取
   - 浏览器附带请求头（Accept / Accept-Language / Accept-Encoding / Sec-Fetch-* /
     sec-ch-ua）按请求类型与 UA 自洽生成；`impersonate: false` 可关闭

   **仍未支持代理**，一旦出口 IP 被拉黑，该站点上所有账号一起失效。
3. **未实现 TOTP**——v2free 账号未开两步验证；如开启需在任务内补约 25 行 TOTP 生成。
4. **`v2free-checkin` 依赖站点两处结构**——套餐/到期等字段解析自账户页内嵌的
   `crispSessionData`，「签到后剩余流量」优先取签到接口返回的 `trafficInfo.unUsedTraffic`
   （站点前端签到成功后就拿它刷新页面上的「剩余」），回读账户页作兜底。
   两处任一站改版都只会让对应字段为 null，界面显示「—」，不会伪造数字。
5. **凭据加密不防主机入侵**——主密钥在服务器上，这是自建部署的固有性质。
6. **`runs.jsonl` 与 CLI 路径并存**——`bin/weauto.mjs run` 仍走老的 JSONL 路径，
   不再被调度使用，仅用于手工调试。
7. **每次执行都重新登录 v2free**——Cookie 仅 1 小时有效，`remember_me` 实测无效。
8. **WorkBuddy token 只有 28 天，且拿不到 refresh_token**。续期发生在客户端**主进程**里
   （`POST /v2/auth/token/refresh`，令牌走 `X-Refresh-Token` 头），渲染层没有任何续期代码，
   内存遍历也搜不到令牌——所以每月要重跑一次本机脚本。任务在剩余 ≤7 天时会报警。
9. **服务器无法主动获取用户本机的东西**。WeAuto 部署在 N150，与用户电脑之间没有任何通道。
   所有"一键"能力都必须由**本机进程主动推送**（`POST /api/tools/push-token`），服务端只能等。
   这是架构边界，不是实现取舍。
10. **macOS 做不到"下载即双击"**（实测见 §5.1）。要彻底不碰终端，只能装常驻定时任务。

### 11.1 为什么没有「网页点一个按钮就授权」（方案 B，已否决）

理论上唯一能跳开本机脚本的做法：让 WorkBuddy 的 SSO 把 WeAuto 视为一个 OAuth 客户端，
走授权码 + PKCE，回调到 weauto 域名，再用 code 换 `access_token` + `refresh_token`。

**2026-10-20 用真实账号实测后否决**，证据：

| 探测 | 结果 |
|---|---|
| realm 发现 | `www.workbuddy.cn/auth/realms/` 下只有 `copilot` 一个（`workbuddy`/`wb`/`personal`/`oneid` 全部 404） |
| 授权页（client=`console`，回调指向本站 `/healthz`，PKCE） | 打开的是**另一个产品的控制台登录页**，登录直接报「账号不存在，请联系企业管理员」 |
| 设备码（device_code） | discovery 声明支持，但该 client 返回 `unauthorized_client` |
| 密码模式 | 同样 `unauthorized_client`；且本就不该做——把主账号密码交给自建服务不成立 |
| 客户端实际登录路径 | 走 OneID（`/oneid/authz/oidc/v2/sso/`），第三方站点驱动不了 |

**它不只是"技术上没通"，还有两个否决理由：**

1. 那个 realm 被多个产品共用，浏览器登录页的品牌不是 WorkBuddy。让 WorkBuddy 用户去
   一个"不像 WorkBuddy"的页面登录，体验比现在跑一次脚本更差。
2. 就算某天打通，我们用的是别人家的 client 配置，对方随时可以收紧——把每月一次的
   自动签到建在这上面，等于埋一颗随时会响的雷。

**结论**：不投入实现。要"页面点按钮"，只剩一条路——本机装一个常驻小代理（见 §11.2）。

### 11.2 如果一定要"页面点按钮"：本机代理

纯网页拿不到 token，但"网页点按钮 + 本机有个常驻小程序"可以：

1. 一次性安装：一个极小的本地程序（macOS launchd / Windows 计划任务），启动时读取
   `~/.weauto/bind.json`（已有的 server + pushToken）。
2. 它每隔一分钟问一次服务端「有没有人点了按钮」（用 pushToken 鉴权，没有就 204）。
3. 用户在页面点「更新凭据」→ 服务端记一条待办 → 代理在一分钟内收到 → 抓 token → 推送 →
   页面自动刷新。

代价：**首次要在本机装一个常驻程序**；抓取时仍需重启客户端（除非让客户端常驻调试端口，
那等于把 token 暴露给本机任意进程）。所以它省掉的是"每月手动跑"，不是"装东西"。

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
| `store.test.mjs` | 任务 CRUD、**多租户隔离**、资源上限、保留策略 |
| `user-secrets.test.mjs` | 加密往返、篡改与错密钥、用户间不可见 |
| `invites.test.mjs` | 生成、四类失效、并发重放、参数上限 |
| `executor.test.mjs` | 幂等按账号、配额、凭据缺失与错密钥 |
| `scheduler.test.mjs` | 调度循环、任务里配的时间生效、单用户串行、停用用户 |
| `server.test.mjs` | 未登录边界、转义、CSRF、邀请注册、删号、平台页 |
| `auth-*.test.mjs` | 密码哈希、token 签发验签、账号存储 |
| `task-contract.test.mjs` / `registry.test.mjs` | 模板契约校验 |
| `task-v2free.test.mjs` | 页面解析（基于真实快照）、签到接口剩余流量、成功 message 的组句 |
| `schedule.test.mjs` / `util.test.mjs` / `format.test.mjs` | 时区与调度算法、格式化 |
| `history.test.mjs` / `lock.test.mjs` / `credentials.test.mjs` / `contract.test.mjs` | 历史路径与跨仓库契约 |
| `pairing.test.mjs` / `task-workbuddy.test.mjs` | 配对码通道；WorkBuddy 抓取脚本 |
