# WeAuto

通用自动化任务框架：**任务注册表 + age 凭据加密 + 结构化执行记录**。

首个任务是 v2free 机场的每日自动签到。设计档见 [`docs/requirements/weauto.md`](docs/requirements/weauto.md)。

---

## 设计要点

**WeAuto 不负责调度。** 调度交给 WeMonitor 已有的 crontab 管理体系（`/cron` 页面），
WeAuto 只做被动 CLI —— 因此本仓库**没有常驻进程、没有端口、没有 systemd 服务**。

```
WeMonitor /cron ──crontab──> weauto run v2free-checkin
                                  │
                                  └──> data/runs.jsonl ──> WeMonitor /auto 页面展示
```

| 系统 | 职责 |
|---|---|
| **WeAuto** | 任务怎么执行：注册表、凭据解密、HTTP 执行、业务记录 |
| **WeMonitor** | 何时执行 + 结果展示：crontab 调度、启停、进程级历史、业务面板 |

**运行时零 npm 依赖** —— 只用 Node 原生 `fetch` / `crypto` / `fs`，外加 `age` 二进制。
部署即解压代码，无需 `npm ci`、无需编译。

---

## 快速开始

```bash
# 1. 安装 age
brew install age                       # macOS
# Linux：见 restart.sh 中的静态二进制安装逻辑

# 2. 生成密钥对（私钥永不入 Git）
mkdir -p ~/.age && chmod 700 ~/.age
age-keygen -o ~/.age/weauto.key        # stdout 会打印公钥

# 3. 填凭据并加密
cp .env.local.template .env.local
$EDITOR .env.local
age -e -r <上一步打印的公钥> -o secrets.age .env.local
rm .env.local                          # 明文不应长期存在

# 4. 使用
node bin/weauto.mjs list                        # 列出任务
node bin/weauto.mjs run v2free-checkin          # 按调度执行
node bin/weauto.mjs run v2free-checkin --force  # 忽略调度窗口，立即执行
node bin/weauto.mjs status                      # 查看执行记录

# 5. 测试（零依赖，用 Node 内置 runner）
npm test
```

---

## CLI

| 命令 | 说明 |
|---|---|
| `weauto run <task> [--force]` | 执行任务。`--force` 跳过调度窗口与幂等检查 |
| `weauto list` | 列出全部已注册任务及今日目标时刻 |
| `weauto status [--json]` | 查看最近执行记录 |

退出码：`0` = 成功或正常跳过；`1` = 失败。WeMonitor 的 cron 历史据此判断成败。

---

## 新增一个任务

在 `tasks/` 放一个 `.mjs` 文件，导出任务对象即可，**无需改动任何框架代码**：

```js
export default {
  name: 'my-task',
  displayName: '我的任务',
  requires: ['MY_TOKEN'],                        // 从 secrets 中校验的字段
  schedule: { window: { start: '09:00', end: '09:50' } },  // 北京时间，可省略

  async run({ secrets, request, CookieJar, log }) {
    // 返回 { status, message, data }
    // status: success | already-signed | failed | blocked | network-error
    return { status: 'success', message: '完成', data: { foo: 'bar' } };
  },
};
```

然后在 WeMonitor 的 `/cron` 页面加一条 crontab 即可。

---

## 随机偏移是怎么做的

需求是每天在 09:00 前后执行，但**每天的偏移不同**，避免固定时刻被识别为机器行为。

不能在任务里 `sleep` —— WeMonitor 的 `cron-runner.js` 用 `execSync` 同步等待且**硬超时 10 分钟**，
睡眠期间被 kill 还会丢掉当天执行。

实际做法：crontab 在窗口内高频触发，任务用「任务名 + 日期」做种子的哈希算出当日固定目标时刻，
未到点直接退出。

```
crontab:  */5 9 * * *                    → 09:00 … 09:55 共 12 次触发
seed   =  sha256("v2free-checkin:2026-10-14")
target =  09:00 + (seed % 3000s)         → 2026-10-14 的目标时刻是 09:33
```

特点：不阻塞进程、当天恒定（天然幂等）、被中断后下次触发可自愈、给定日期可预测（可测试）。

---

## 凭据安全

`secrets.age` 是 age 加密的密文，**可以安全地提交进 Git，并随 Release 包分发**；
私钥 `~/.age/weauto.key` 永不入 Git，必须手动放到运行机器上。

> **为什么密文必须打进 Release 包**：deploy-agent 用
> `rsync -a --delete --exclude 'data' --exclude '.env'` 同步部署目录，
> **凡不在包内的文件都会被 `--delete` 清掉**（首次部署时踩过此坑，密文被删导致 `config-error`）。
> 密文不敏感，且 Git 是它的唯一权威来源 —— 因此随包分发是最自洽的做法：
> 若在机器上直接修改密文，下次部署会被仓库中的版本覆盖。
> 要更新凭据，应在本地重新加密后提交，让变更走 Git → CI → 部署链路。

**必须清楚加密的防护边界**：

| 威胁 | 加密是否有效 |
|---|---|
| 密码进入 Git 历史 / 被推送泄露 | ✅ 有效（这是加密的核心价值） |
| 备份、rsync 快照泄露 | ✅ 有效 |
| 有人登录机器顺手 `cat` 文件 | ✅ 有效 |
| 机器被完整攻陷（拿到文件系统） | ❌ **无效** —— 密文与私钥在同一台机器上 |

因为任务需无人值守自动执行，解密私钥**必须**存在于运行机器上。加密保护的是
「凭据在传输与存储链路上不被顺走」，不是「机器沦陷后仍安全」。

### 私钥是唯一的单点，请单独备份

`secrets.age` 丢了无所谓（Git 里有）；**私钥丢了就再也解不开**：

- 它不在 Git 里，也不随 Release 分发
- 目前只存在于两处：开发机的 `~/.age/weauto.key` 与运行机上的同名文件
- 这两处同时损毁（换机、误删 home、磁盘故障）＝ 凭据永久丢失，只能去站点重新申请

所以私钥需要一份**脱离这两台机器**的备份（密码管理器、加密 U 盘等）。
这个动作只能由人来做 —— 交给自动化工具，只是把单点从两台机器扩散到一个脚本里。

轮换凭据的完整流程：

```bash
# 1. 改明文（仅改密码的话，跳过 age-keygen）
cp .env.local.template .env.local && $EDITOR .env.local

# 2. 用公钥重新加密（公钥可从私钥导出，无需再次留存）
age -e -r "$(age-keygen -y ~/.age/weauto.key)" -o secrets.age .env.local
rm .env.local

# 3. 提交并发版：密文走 Git → CI → 部署链路覆盖运行机上的旧密文
git add secrets.age && git commit -m "chore: rotate v2free credentials" && git push
```

**不要直接改运行机上的 `secrets.age`** —— `rsync --delete` 会在下次部署时用仓库版本覆盖它。

---

## 测试

```bash
npm test        # node --test tests/*.test.mjs；零依赖，用 Node 内置 runner
```

CI 在打包之前跑测试，不过就不发 Release。覆盖三类东西：

1. **纯逻辑** —— 种子化调度（落在窗口内、跨天分散）、幂等判断（任务名 + 日期 + 成功状态）、
   进程锁的时序边界、任务定义校验、页面解析正则。
2. **真实快照** —— `tests/fixtures/v2free-user-signed.html` 是从真实页面脱敏而来。
   站点改版后解析会失效，这个 fixture 让「正则与真实页面脱节」在本地就能被发现。
3. **跨仓库契约** —— `status` 取值集合、`list --json` 结构、退出码约定。
   另一半在 WeMonitor 的 `tests/auto-contract.test.mjs`。

取舍：不追覆盖率数字，只测「错了不会报错、只会静默出错」的地方 ——
调度偏移、幂等判定、正则解析都属于这一类。

---

## 部署（N150）

N150 走既有的 `CI → Release → webhook → deploy-agent` 链路。因为 WeAuto 是无端口项目
（`deploy-agent.sh` 对空 PORT 会跳过健康检查），配置只需一行：

```
# ~/.deploy-projects.conf（PORT 字段留空）
weauto|sherlockguo-yc/WeAuto|$HOME/weauto||sha|weauto.tar.gz
```

部署后 `restart.sh` 会自动：安装 age（若缺失）、收紧 `data/` 与密钥权限、自检凭据能否解密。

调度在 WeMonitor `/cron` 页面添加，命令为：

```
/usr/local/bin/node /home/sherlockguo/weauto/bin/weauto.mjs run v2free-checkin
```

推荐调度表达式：`*/5 9 * * *`（N150 系统时区为 `Asia/Shanghai`，即北京时间 09:00–09:55）。

---

## 目录结构

```
bin/weauto.mjs           CLI 入口
src/util.mjs             路径常量、dotenv 解析、时区计算
src/secrets.mjs          age 解密到内存（明文不落盘）
src/http.mjs             CookieJar + fetch 封装
src/history.mjs          runs.jsonl 读写与幂等判断
src/schedule.mjs         种子化随机调度
src/registry.mjs         任务注册表（扫描 tasks/，加载期校验）
src/lock.mjs             进程锁（陈旧判定 + 年龄兜底）
src/runner.mjs           执行器：锁 → 门禁 → 幂等 → 解密 → 执行 → 记录
tasks/v2free-checkin.mjs v2free 签到任务
scripts/probe.mjs        接口探针（一次性验证脚本，可保留作调试）
tests/                   node:test 单元/契约测试（fixtures/ 放真实快照）
data/                    运行时数据（runs.jsonl / 锁文件），已 gitignore
secrets.age              加密凭据（入 Git）
```
