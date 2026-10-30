/**
 * 数据访问层 —— 任务配置、账号、执行记录、运行日志、调度状态、每日统计
 *
 * 【单租户 → 多租户的结构性变化】
 *   以前所有方法都以 `task_name` 为唯一维度，任务属于「这台机器」。
 *   现在「这个任务在我这儿怎么跑」属于某个用户，所以本模块对外**只提供绑定了用户的视图**：
 *
 *     const store = createStore(db);
 *     const mine = store.forUser(req.user.id);
 *     mine.runsOfTask('v2free-checkin');      // 只会返回这个用户的记录
 *
 *   为什么是「视图」而不是「每个方法加一个 userId 参数」：
 *   多租户下漏一次 `WHERE user_id` 就是跨用户数据泄露，而这里有二十多个方法，
 *   靠每个调用点记得传参数迟早会漏一个。绑定视图让调用方**拿不到不带用户的 store**，
 *   漏过滤在结构上就不可能发生。
 *
 *   `subscriptions` 这张表存的就是「我的任务配置」：启停、调度、超时，
 *   以及我在这个任务下配的账号。表名沿用建表时的叫法（迁移只追加不改），
 *   对外一律叫「任务配置」——用户视角里没有「订阅」这个概念。
 *
 *   全局对象只保留后台必需的三个入口：`forUser` / `allConfigs` / `allUserIds`
 *   （调度器与保留策略要跨用户遍历），以及 `purgeUser`（删号清理）。
 *
 * 两条与保留策略相关的约定（沿用）：
 *   · 删除明细前先把计数累加进 run_stats_daily，这样长期趋势仍可查
 *   · 统计是**累加计数器**（每行明细只会被累加一次，因为累加后立刻删除）
 */
import crypto from 'node:crypto';
import { SUCCESS_STATUSES } from './task-contract.mjs';
import { timestampInTZ } from './util.mjs';

const DAY_MS = 86_400_000;

/** 账号标识。不让用户填的名字当主键——名字可改，而这个 key 会写进 runs 与 task_state */
export function newAccountKey() {
  return `a-${crypto.randomBytes(4).toString('hex')}`;
}

function rowToRun(row) {
  if (!row) return null;
  let data = null;
  if (row.data_json) {
    try {
      data = JSON.parse(row.data_json);
    } catch {
      data = { _parseError: true, raw: row.data_json };
    }
  }
  return {
    id: row.id,
    userId: row.user_id,
    subscriptionId: row.subscription_id ?? null,
    task: row.task_name,
    /*
     * 归一成字符串。account_key 在迁移 2 里是可空列，命令行时代导入的历史记录是 NULL，
     * 而账号表里「默认」账号的 key 是 ''——一 NULL 一 '' 会拼出两个不同的 map key，
     * status.mjs 匹配不上就回退显示原始任务名（2026-10-15 生产实测）。
     * 读出来统一成 '' 之后不会再出现这种错配。
     */
    accountKey: row.account_key ?? '',
    date: row.date,
    ts: row.ts,
    /** 展示用的北京时间字符串。ts 是 epoch **毫秒**，页面不直接用它 */
    time: timestampInTZ(new Date(row.ts)),
    status: row.status,
    message: row.message,
    data,
    dur: row.dur,
    trigger: row.trigger,
  };
}

/** 一行订阅 = 一个任务（一个账号）。account_key 保留：凭据、调度状态、历史都按它分 */
function rowToTask(row) {
  if (!row) return null;
  let schedule = null;
  if (row.schedule_json) {
    try {
      schedule = JSON.parse(row.schedule_json);
    } catch {
      schedule = null;
    }
  }
  return {
    id: row.id,
    userId: row.user_id,
    taskName: row.task_name,
    /** 凭据 / 调度状态 / 执行历史的维度——执行侧仍然需要它 */
    accountKey: row.account_key ?? '',
    label: row.label ?? '',
    enabled: !!row.enabled,
    schedule,
    timeoutMs: row.timeout_ms ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createStore(db, { limits = {} } = {}) {
  const successList = [...SUCCESS_STATUSES];
  const inClause = successList.map(() => '?').join(',');

  /* 上限由装配层注入（config.TENANT_LIMITS），本模块不读环境变量 */
  const maxSubscriptions = limits.maxSubscriptions ?? Infinity;
  const maxAccounts = limits.maxAccountsPerSubscription ?? Infinity;
  const minIntervalMinutes = limits.minIntervalMinutes ?? 0;

  /** 间隔下限：防止有人配成 1 分钟一次，把目标站和 N150 的出口 IP 一起拖垮 */
  function assertScheduleAllowed(schedule) {
    if (schedule?.kind !== 'every') return;
    const minutes = Number(schedule.every?.minutes);
    if (!Number.isFinite(minutes) || minutes < minIntervalMinutes) {
      throw new Error(`间隔不能小于 ${minIntervalMinutes} 分钟`);
    }
  }

  /** 任务总数上限：一个模板建多个任务也算多个，所以按这个用户已有的任务行数算 */
  function assertTaskAllowed(userId) {
    if (s.tasksOfUser.all(userId).length >= maxSubscriptions) {
      throw new Error(`任务数已达上限（最多 ${maxSubscriptions} 个）`);
    }
  }

  const s = {
    /* ───────── 任务（一行 = 一个任务 = 一个账号） ───────── */
    taskById: db.prepare('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?'),
    taskByKey: db.prepare(
      'SELECT * FROM subscriptions WHERE user_id = ? AND task_name = ? AND account_key = ?',
    ),
    tasksOfUser: db.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id'),
    tasksOfTemplate: db.prepare(
      'SELECT * FROM subscriptions WHERE user_id = ? AND task_name = ? ORDER BY id',
    ),
    allSubs: db.prepare('SELECT * FROM subscriptions ORDER BY user_id, task_name'),
    // 调度器用：停用用户的任务不该继续往目标站点发请求
    allSubsActive: db.prepare(
      `SELECT s.* FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE u.status = 'active'
       ORDER BY s.user_id, s.task_name`,
    ),
    insertTask: db.prepare(
      `INSERT INTO subscriptions (user_id, task_name, account_key, label, enabled, schedule_json, timeout_ms, created_at, updated_at)
       VALUES (@user_id, @task_name, @account_key, @label, @enabled, @schedule_json, @timeout_ms, @created_at, @updated_at)`,
    ),
    updateTask: db.prepare(
      `UPDATE subscriptions SET
         enabled = @enabled, schedule_json = @schedule_json, timeout_ms = @timeout_ms,
         label = @label, updated_at = @updated_at
       WHERE id = @id AND user_id = @user_id`,
    ),
    deleteTask: db.prepare('DELETE FROM subscriptions WHERE id = ? AND user_id = ?'),
    deleteSubsOfUser: db.prepare('DELETE FROM subscriptions WHERE user_id = ?'),

    /* ───────── 执行记录 ───────── */
    insertRun: db.prepare(
      `INSERT INTO runs (user_id, subscription_id, task_name, account_key, date, ts, status, message, data_json, dur, trigger)
       VALUES (@user_id, @subscription_id, @task_name, @account_key, @date, @ts, @status,
               @message, @data_json, @dur, @trigger)`,
    ),
    runById: db.prepare('SELECT * FROM runs WHERE id = ?'),
    runsOfTask: db.prepare(
      'SELECT * FROM runs WHERE user_id = ? AND task_name = ? AND account_key = ? ORDER BY ts DESC LIMIT ?',
    ),
    runsOfSubscription: db.prepare(
      'SELECT * FROM runs WHERE user_id = ? AND task_name = ? ORDER BY ts DESC LIMIT ?',
    ),
    runsAll: db.prepare('SELECT * FROM runs WHERE user_id = ? ORDER BY ts DESC LIMIT ?'),
    // 历史列表默认隐藏 skipped：否则 interval 类任务会把有用的行挤下去
    runsExecuted: db.prepare(
      `SELECT * FROM runs WHERE user_id = ? AND status <> 'skipped' ORDER BY ts DESC LIMIT ?`,
    ),
    /* 「在 SQL 里先排除 skipped、再取条数」的同一组查询。
       任务详情页以前是先取 50 条再在 JS 里过滤，于是「最近 50 条全是 skipped」时
       详情页一条都不剩，而首页仍然给得出 20 条 —— 两处记录对不上。
       与首页 recentRuns 走同一个口径（先过滤后取数）后就不会再出现这种偏差。 */
    runsOfTaskExecuted: db.prepare(
      `SELECT * FROM runs WHERE user_id = ? AND task_name = ? AND account_key = ?
       AND status <> 'skipped' ORDER BY ts DESC LIMIT ?`,
    ),
    runsOfSubscriptionExecuted: db.prepare(
      `SELECT * FROM runs WHERE user_id = ? AND task_name = ?
       AND status <> 'skipped' ORDER BY ts DESC LIMIT ?`,
    ),
    /* 历史翻页：keyset（游标）而不是 OFFSET。
       OFFSET 在「翻页期间又跑了一次任务」时会整体后移一位，同一行出现两次、或整段被跳过；
       游标只问「比这条更早的还有哪些」，写入新记录不会影响已翻开的位置。

       排序多带一个 id DESC：同一毫秒内的多条记录（手动连点、批量导入）光靠 ts
       分不出先后，游标就会切在同一秒中间，翻页时重复或漏行。 */
    runsPageOfTask: db.prepare(
      `SELECT * FROM runs WHERE user_id = ? AND task_name = ? AND account_key = ?
       AND (ts < ? OR (ts = ? AND id < ?))
       ORDER BY ts DESC, id DESC LIMIT ?`,
    ),
    runsPageOfTaskExecuted: db.prepare(
      `SELECT * FROM runs WHERE user_id = ? AND task_name = ? AND account_key = ?
       AND status <> 'skipped' AND (ts < ? OR (ts = ? AND id < ?))
       ORDER BY ts DESC, id DESC LIMIT ?`,
    ),
    runsPageOfSubscription: db.prepare(
      `SELECT * FROM runs WHERE user_id = ? AND task_name = ?
       AND (ts < ? OR (ts = ? AND id < ?))
       ORDER BY ts DESC, id DESC LIMIT ?`,
    ),
    runsPageOfSubscriptionExecuted: db.prepare(
      `SELECT * FROM runs WHERE user_id = ? AND task_name = ?
       AND status <> 'skipped' AND (ts < ? OR (ts = ? AND id < ?))
       ORDER BY ts DESC, id DESC LIMIT ?`,
    ),
    lastSuccess: db.prepare(
      `SELECT * FROM runs WHERE user_id = ? AND task_name = ? AND account_key = ?
       AND status IN (${inClause}) ORDER BY ts DESC LIMIT 1`,
    ),
    successOnDate: db.prepare(
      `SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND task_name = ? AND account_key = ?
       AND date = ? AND status IN (${inClause})`,
    ),
    scheduledCount: db.prepare(
      `SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND task_name = ? AND account_key = ?
       AND trigger = 'schedule'`,
    ),
    allRunsForPrune: db.prepare(
      'SELECT id, date, status, ts FROM runs WHERE user_id = ? AND task_name = ? ORDER BY ts ASC',
    ),
    deleteRun: db.prepare('DELETE FROM runs WHERE id = ?'),
    deleteRunsOfUser: db.prepare('DELETE FROM runs WHERE user_id = ?'),
    // 配额计数：skipped 不计入，它代表「没真的发出请求」
    countRunsToday: db.prepare(
      `SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND date = ? AND status <> 'skipped'`,
    ),
    /** 配额超限的提示当天只记一次，否则每 30 秒一条 */
    countQuotaSkips: db.prepare(
      `SELECT COUNT(*) AS n FROM runs
       WHERE user_id = ? AND date = ? AND task_name = ? AND account_key = ?
         AND status = 'skipped' AND message LIKE '%配额%'`,
    ),

    /* ───────── 日志 ───────── */
    insertLog: db.prepare(
      'INSERT INTO run_logs (run_id, user_id, task_name, ts, line) VALUES (?, ?, ?, ?, ?)',
    ),
    logsOfRun: db.prepare('SELECT ts, line FROM run_logs WHERE run_id = ? ORDER BY id'),
    deleteLogsBefore: db.prepare('DELETE FROM run_logs WHERE user_id = ? AND task_name = ? AND ts < ?'),
    deleteLogsOfUser: db.prepare('DELETE FROM run_logs WHERE user_id = ?'),

    /* ───────── 调度状态 ───────── */
    getState: db.prepare(
      'SELECT * FROM task_state WHERE user_id = ? AND task_name = ? AND account_key = ?',
    ),
    upsertState: db.prepare(
      `INSERT INTO task_state (user_id, task_name, account_key, today_date, today_target_ts,
                               next_due_ts, last_run_id, updated_at)
       VALUES (@user_id, @task_name, @account_key, @today_date, @today_target_ts,
               @next_due_ts, @last_run_id, @updated_at)
       ON CONFLICT(user_id, task_name, account_key) DO UPDATE SET
         today_date = @today_date, today_target_ts = @today_target_ts,
         next_due_ts = @next_due_ts, last_run_id = @last_run_id, updated_at = @updated_at`,
    ),
    deleteStatesOfUser: db.prepare('DELETE FROM task_state WHERE user_id = ?'),

    /* ───────── 统计 ───────── */
    statsOfTask: db.prepare(
      'SELECT * FROM run_stats_daily WHERE user_id = ? AND task_name = ? ORDER BY date DESC LIMIT ?',
    ),
    addStat: db.prepare(
      `INSERT INTO run_stats_daily (user_id, task_name, date, success, failed, skipped, total)
       VALUES (@user_id, @task_name, @date, @success, @failed, @skipped, @total)
       ON CONFLICT(user_id, task_name, date) DO UPDATE SET
         success = success + excluded.success,
         failed  = failed  + excluded.failed,
         skipped = skipped + excluded.skipped,
         total   = total   + excluded.total`,
    ),
    deleteStatsOfUser: db.prepare('DELETE FROM run_stats_daily WHERE user_id = ?'),

    /* ───────── 平台视角（/admin 用，跨用户只读统计） ───────── */
    statusesOnDate: db.prepare('SELECT status, COUNT(*) AS n FROM runs WHERE date = ? GROUP BY status'),
    subCount: db.prepare('SELECT COUNT(*) AS n FROM subscriptions'),
    enabledSubCount: db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE enabled = 1'),
  };

  /* ─────────────────── 用户视图 ─────────────────── */

  function makeUserStore(userId) {
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error(`forUser 需要正整数 userId，收到 ${userId}`);
    }

    /** 我的全部任务（每行一个，跨模板） */
    function listTasks() {
      return s.tasksOfUser.all(userId).map(rowToTask);
    }

    /** 单个任务。取不到（不是我的 / 不存在）返回 null，绝不跨用户 */
    function getTask(id) {
      return rowToTask(s.taskById.get(Number(id), userId));
    }

    /** 我在这个模板下建了哪些任务 */
    function tasksOfTemplate(taskName) {
      return s.tasksOfTemplate.all(userId, taskName).map(rowToTask);
    }

    /**
     * 从一个模板建一个任务。
     *
     * 一个任务 = 一个账号，所以每个任务自带一个新的 account_key：
     * 凭据、调度状态、执行历史都按 (user, task_name, account_key) 分开存，
     * 两个任务之间不会互相覆盖。
     */
    function createTask(taskName, { label = '', enabled = true, schedule = null, timeoutMs = null, accountKey = null } = {}) {
      assertTaskAllowed(userId);
      assertScheduleAllowed(schedule);
      const info = s.insertTask.run({
        user_id: userId,
        task_name: taskName,
        account_key: accountKey ?? newAccountKey(),
        label: String(label || '').slice(0, 32),
        enabled: enabled ? 1 : 0,
        schedule_json: schedule ? JSON.stringify(schedule) : null,
        timeout_ms: timeoutMs,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      return getTask(info.lastInsertRowid);
    }

    /** 改任务的启停 / 调度 / 超时 / 名字；只写传进来的字段 */
    function updateTask(id, { enabled, schedule, timeoutMs, label } = {}) {
      const prev = s.taskById.get(Number(id), userId);
      if (!prev) return null;
      assertScheduleAllowed(schedule);
      const prevSchedule = prev.schedule_json ? JSON.parse(prev.schedule_json) : null;
      s.updateTask.run({
        id: Number(id),
        user_id: userId,
        enabled: (enabled ?? prev.enabled) ? 1 : 0,
        schedule_json: schedule === undefined
          ? (prevSchedule ? JSON.stringify(prevSchedule) : null)
          : schedule
            ? JSON.stringify(schedule)
            : null,
        timeout_ms: timeoutMs === undefined ? prev.timeout_ms : timeoutMs,
        label: label === undefined ? prev.label ?? '' : String(label || '').slice(0, 32),
        updated_at: Date.now(),
      });
      return getTask(id);
    }

    /** 删掉这个任务（历史记录保留，那是发生过的事实） */
    function deleteTask(id) {
      return s.deleteTask.run(Number(id), userId).changes > 0;
    }

    /**
     * 兼容入口：确保这个模板至少有一个任务（历史导入、启动回填用）。
     * 不用于新建——用户建任务走 createTask()。
     */
    function ensureConfig(taskName, { enabled = true, schedule = null, timeoutMs = null } = {}) {
      const existing = s.tasksOfTemplate.all(userId, taskName);
      if (existing.length) return rowToTask(existing[0]);
      return createTask(taskName, { enabled, schedule, timeoutMs });
    }

    /** 任务的启停 / 调度 / 超时；status 模块用它推导今日状态 */
    function configOfTask(id) {
      const row = s.taskById.get(Number(id), userId);
      if (!row) return null;
      return {
        id: row.id,
        taskName: row.task_name,
        accountKey: row.account_key ?? '',
        enabled: !!row.enabled,
        schedule: rowToTask(row).schedule,
        timeoutMs: row.timeout_ms ?? null,
        updatedAt: row.updated_at,
      };
    }

    function appendRun({
      taskName,
      accountKey = '',
      subscriptionId = null,
      date,
      ts,
      status,
      message = '',
      data = null,
      dur = 0,
      trigger = 'schedule',
    }) {
      const subId =
        subscriptionId ?? s.taskByKey.get(userId, taskName, accountKey ?? '')?.id ?? null;
      const info = s.insertRun.run({
        user_id: userId,
        subscription_id: subId,
        task_name: taskName,
        account_key: accountKey,
        date,
        ts,
        status,
        message,
        data_json: data == null ? null : JSON.stringify(data),
        dur,
        trigger,
      });
      return rowToRun(s.runById.get(info.lastInsertRowid));
    }

    /**
     * 某个账号的历史；不传 accountKey 时返回该模板下全部账号的历史。
     *
     * `includeSkipped = true` 是历史默认（取到的就是最近 N 条，含 skipped）；
     * 页面要展示时传 false，走「先排除 skipped 再取 N 条」的查询，
     * 这样条数不会被一堆 skipped 吃掉（与首页 recentRuns 同一口径）。
     */
    function runsOfTask(taskName, { accountKey = null, limit = 50, includeSkipped = true } = {}) {
      const rows =
        accountKey == null
          ? includeSkipped
            ? s.runsOfSubscription.all(userId, taskName, limit)
            : s.runsOfSubscriptionExecuted.all(userId, taskName, limit)
          : includeSkipped
            ? s.runsOfTask.all(userId, taskName, accountKey, limit)
            : s.runsOfTaskExecuted.all(userId, taskName, accountKey, limit);
      return rows.map(rowToRun);
    }

    /**
     * 分页取历史：任务页首屏只渲染一屏，滚动到底再拿下一页。
     *
     * `before` 是上一页最后一条的 `{ ts, id }`（游标），不传表示从最新一条开始。
     * 返回值**一定要用「多取一条」的方式判断还有没有下一页**——
     * 只看「这次拿到的条数是否等于 limit」会漏判：记录数恰好是 limit 的整数倍时，
     * 最后一页会多出一次什么都没拿到的请求。
     *
     * @returns {object[]} 该页的记录（新的在前）
     */
    function runsOfTaskPage(
      taskName,
      { accountKey = null, limit = 20, includeSkipped = false, before = null } = {},
    ) {
      // 游标缺省为「最大」，等价于「从最新一条开始」，于是首屏与后续页走同一条语句，
      // 排序规则不会在翻页边界上换一套（否则同毫秒的多条记录会在两页间错位）
      const ts = before?.ts ?? Number.MAX_SAFE_INTEGER;
      const id = before?.id ?? Number.MAX_SAFE_INTEGER;
      const rows =
        accountKey == null
          ? (includeSkipped ? s.runsPageOfSubscription : s.runsPageOfSubscriptionExecuted).all(
              userId,
              taskName,
              ts,
              ts,
              id,
              limit,
            )
          : (includeSkipped ? s.runsPageOfTask : s.runsPageOfTaskExecuted).all(
              userId,
              taskName,
              accountKey,
              ts,
              ts,
              id,
              limit,
            );
      return rows.map(rowToRun);
    }

    /** 我的全部任务最近记录；默认隐藏 skipped（首页要的是「谁出事了」） */
    function recentRuns(limit = 50, { includeSkipped = false } = {}) {
      const rows = includeSkipped ? s.runsAll.all(userId, limit) : s.runsExecuted.all(userId, limit);
      return rows.map(rowToRun);
    }

    function lastSuccess(taskName, accountKey = '') {
      return rowToRun(s.lastSuccess.get(userId, taskName, accountKey, ...successList));
    }

    /**
     * 今天这个账号是否已经成功。
     * accountKey 必须参与判断：同一用户下 A 账号成功不代表 B 账号也成功了。
     */
    function hasSuccessOn(taskName, date, accountKey = '') {
      return s.successOnDate.get(userId, taskName, accountKey, date, ...successList).n > 0;
    }

    /** 一次性任务是否已经跑过（只算调度触发的），同样按账号区分 */
    function hasScheduledRun(taskName, accountKey = '') {
      return s.scheduledCount.get(userId, taskName, accountKey).n > 0;
    }

    function appendLogs(runId, taskName, lines, ts = Date.now()) {
      const tx = db.transaction(() => {
        for (const line of lines) s.insertLog.run(runId, userId, taskName, ts, String(line));
      });
      tx();
    }

    function stateOf(taskName, accountKey = '') {
      const row = s.getState.get(userId, taskName, accountKey);
      return row
        ? {
            today_date: row.today_date,
            today_target_ts: row.today_target_ts,
            next_due_ts: row.next_due_ts,
            last_run_id: row.last_run_id,
          }
        : {};
    }

    /** 局部更新调度状态（合并式写入，调用方只关心自己那几个字段） */
    function saveState(taskName, accountKey = '', patch = {}) {
      const merged = { ...stateOf(taskName, accountKey), ...patch };
      s.upsertState.run({
        user_id: userId,
        task_name: taskName,
        account_key: accountKey,
        today_date: merged.today_date ?? null,
        today_target_ts: merged.today_target_ts ?? null,
        next_due_ts: merged.next_due_ts ?? null,
        last_run_id: merged.last_run_id ?? null,
        updated_at: Date.now(),
      });
      return stateOf(taskName, accountKey);
    }

    function statsOfTask(taskName, limit = 90) {
      return s.statsOfTask.all(userId, taskName, limit);
    }

    /**
     * 保留策略：先聚合、再删明细。
     * 两个维度都要：只按天数删挡不住 interval 类任务；只按条数删会留着陈年记录。
     */
    function pruneTask(taskName, retention, nowMs = Date.now()) {
      const cutoff = nowMs - retention.days * DAY_MS;
      const all = s.allRunsForPrune.all(userId, taskName);

      const keep = [];
      const drop = [];
      for (const r of all) (r.ts < cutoff ? drop : keep).push(r);

      const over = keep.length - retention.maxRows;
      if (over > 0) drop.push(...keep.splice(0, over));

      if (!drop.length) return { dropped: 0, aggregated: 0 };

      const byDate = new Map();
      for (const r of drop) {
        const acc = byDate.get(r.date) ?? { success: 0, failed: 0, skipped: 0, total: 0 };
        if (SUCCESS_STATUSES.has(r.status)) acc.success += 1;
        else if (r.status === 'skipped') acc.skipped += 1;
        else acc.failed += 1;
        acc.total += 1;
        byDate.set(r.date, acc);
      }

      const tx = db.transaction(() => {
        for (const [date, acc] of byDate) {
          s.addStat.run({ user_id: userId, task_name: taskName, date, ...acc });
        }
        for (const r of drop) s.deleteRun.run(r.id);
      });
      tx();

      // 日志按自己的保留期单独清理（随 runs 级联删除的那部分已自动处理）
      const logCutoff = nowMs - (retention.logDays ?? retention.days) * DAY_MS;
      const { changes } = s.deleteLogsBefore.run(userId, taskName, logCutoff);

      return { dropped: drop.length, aggregated: byDate.size, logsDropped: changes };
    }

    return {
      userId,
      listTasks,
      getTask,
      tasksOfTemplate,
      createTask,
      updateTask,
      deleteTask,
      ensureConfig,
      configOfTask,
      appendRun,
      runsOfTask,
      runsOfTaskPage,
      recentRuns,
      lastSuccess,
      hasSuccessOn,
      hasScheduledRun,
      /** 今日已执行次数（配额用） */
      countRunsToday: (date) => s.countRunsToday.get(userId, date).n,
      /** 当天是否已记过一条「配额超限」（避免每轮 tick 都写） */
      countQuotaSkips: (date, taskName, accountKey = '') =>
        s.countQuotaSkips.get(userId, date, taskName, accountKey).n,
      appendLogs,
      logsOfRun: (runId) => s.logsOfRun.all(runId),
      getRun: (id) => rowToRun(s.runById.get(id)),
      stateOf,
      saveState,
      statsOfTask,
      pruneTask,
    };
  }

  return {
    /** 唯一的用户级入口。页面与执行路径都从这里拿 store */
    forUser: makeUserStore,

    /**
     * 所有人的任务（调度器跨用户遍历用）。一行 = 一个任务 = 一个账号。
     * @param {boolean} [onlyActiveUsers] 调度器要传 true：停用用户的任务不该继续发请求
     */
    allTasks({ onlyActiveUsers = false } = {}) {
      const rows = onlyActiveUsers ? s.allSubsActive.all() : s.allSubs.all();
      return rows.map(rowToTask);
    },

    /** 保留策略用：有哪些用户在库里有任务配置 */
    allUserIds() {
      return [...new Set(s.allSubs.all().map((r) => r.user_id))];
    },

    /** /admin 用：全平台某天的执行概况 */
    platformStats(date) {
      const out = { success: 0, failed: 0, skipped: 0, total: 0 };
      for (const row of s.statusesOnDate.all(date)) {
        out.total += row.n;
        if (SUCCESS_STATUSES.has(row.status)) out.success += row.n;
        else if (row.status === 'skipped') out.skipped += row.n;
        else out.failed += row.n;
      }
      return out;
    },

    /** /admin 用：全平台有多少份任务配置、其中多少是启动状态 */
    configCounts() {
      return { total: s.subCount.get().n, enabled: s.enabledSubCount.get().n };
    },

    /**
     * 删号清理：任务配置与账号靠 ON DELETE CASCADE，这里清掉没有外键兜底的历史数据。
     * runs 一并删除而不是留 user_id=NULL——否则统计里会出现没有主人的幽灵行
     * （需求文档 §8 风险 6）。凭据由 user-secrets 模块单独删。
     */
    purgeUser(userId) {
      const tx = db.transaction(() => {
        s.deleteRunsOfUser.run(userId);
        s.deleteLogsOfUser.run(userId);
        s.deleteStatsOfUser.run(userId);
        s.deleteStatesOfUser.run(userId);
        s.deleteSubsOfUser.run(userId);
      });
      tx();
    },
  };
}
