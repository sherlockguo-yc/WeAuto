/**
 * 数据访问层 —— 订阅、账号、执行记录、运行日志、调度状态、每日统计
 *
 * 【单租户 → 多租户的结构性变化】
 *   以前所有方法都以 `task_name` 为唯一维度，任务属于「这台机器」。
 *   现在任务实例属于某个用户，所以本模块对外**只提供绑定了用户的视图**：
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
 *   全局对象只保留后台必需的三个入口：`forUser` / `allSubscriptions` / `allUserIds`
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
    accountKey: row.account_key,
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

function rowToSubscription(row) {
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
    enabled: !!row.enabled,
    schedule,
    timeoutMs: row.timeout_ms ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAccount(row) {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    accountKey: row.account_key,
    label: row.label,
    enabled: !!row.enabled,
    createdAt: row.created_at,
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

  function assertSubscriptionAllowed(userId, taskName) {
    if (s.subOf.get(userId, taskName)) return; // 已订阅 → 是更新，不占新名额
    if (s.subsOfUser.all(userId).length >= maxSubscriptions) {
      throw new Error(`订阅数已达上限（${maxSubscriptions} 个）`);
    }
  }

  const s = {
    /* ───────── 订阅 ───────── */
    subOf: db.prepare('SELECT * FROM subscriptions WHERE user_id = ? AND task_name = ?'),
    subsOfUser: db.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY task_name'),
    allSubs: db.prepare('SELECT * FROM subscriptions ORDER BY user_id, task_name'),
    // 调度器用：停用的账号不该继续往目标站点发请求
    allSubsActive: db.prepare(
      `SELECT s.* FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE u.status = 'active'
       ORDER BY s.user_id, s.task_name`,
    ),
    insertSub: db.prepare(
      `INSERT INTO subscriptions (user_id, task_name, enabled, schedule_json, timeout_ms, created_at, updated_at)
       VALUES (@user_id, @task_name, @enabled, @schedule_json, @timeout_ms, @created_at, @updated_at)
       ON CONFLICT(user_id, task_name) DO UPDATE SET
         enabled = excluded.enabled, schedule_json = excluded.schedule_json,
         timeout_ms = excluded.timeout_ms, updated_at = excluded.updated_at`,
    ),
    deleteSub: db.prepare('DELETE FROM subscriptions WHERE user_id = ? AND task_name = ?'),
    deleteSubsOfUser: db.prepare('DELETE FROM subscriptions WHERE user_id = ?'),

    /* ───────── 账号 ───────── */
    accountsOfSub: db.prepare(
      'SELECT * FROM subscription_accounts WHERE subscription_id = ? ORDER BY id',
    ),
    accountOfSub: db.prepare(
      'SELECT * FROM subscription_accounts WHERE subscription_id = ? AND account_key = ?',
    ),
    insertAccount: db.prepare(
      `INSERT INTO subscription_accounts (subscription_id, account_key, label, enabled, created_at)
       VALUES (@subscription_id, @account_key, @label, @enabled, @created_at)`,
    ),
    deleteAccount: db.prepare(
      'DELETE FROM subscription_accounts WHERE subscription_id = ? AND account_key = ?',
    ),

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
  };

  /* ─────────────────── 用户视图 ─────────────────── */

  function makeUserStore(userId) {
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error(`forUser 需要正整数 userId，收到 ${userId}`);
    }

    function getSubscription(taskName) {
      const row = s.subOf.get(userId, taskName);
      if (!row) return null;
      const sub = rowToSubscription(row);
      sub.accounts = s.accountsOfSub.all(row.id).map(rowToAccount);
      return sub;
    }

    /**
     * 订阅一个模板。幂等：已订阅则更新配置，不会重复建行。
     * 首次订阅会自动建一个默认账号（account_key = ''）——单账号模板就用它，
     * 否则用户还得先「添加账号」才能填凭据，多一步没必要的操作。
     */
    function subscribe(taskName, { enabled = true, schedule = null, timeoutMs = null } = {}) {
      assertSubscriptionAllowed(userId, taskName);
      assertScheduleAllowed(schedule);
      const prev = s.subOf.get(userId, taskName);
      s.insertSub.run({
        user_id: userId,
        task_name: taskName,
        enabled: enabled ? 1 : 0,
        schedule_json: schedule ? JSON.stringify(schedule) : null,
        timeout_ms: timeoutMs,
        created_at: prev?.created_at ?? Date.now(),
        updated_at: Date.now(),
      });
      const row = s.subOf.get(userId, taskName);
      if (!s.accountsOfSub.all(row.id).length) {
        s.insertAccount.run({
          subscription_id: row.id,
          account_key: '',
          label: '默认',
          enabled: 1,
          created_at: Date.now(),
        });
      }
      return getSubscription(taskName);
    }

    function unsubscribe(taskName) {
      return s.deleteSub.run(userId, taskName).changes > 0;
    }

    function listSubscriptions() {
      return s.subsOfUser.all(userId).map((row) => {
        const sub = rowToSubscription(row);
        sub.accounts = s.accountsOfSub.all(row.id).map(rowToAccount);
        return sub;
      });
    }

    /** 多账号模板才需要；单账号模板只有 account_key='' 那一条 */
    function addAccount(taskName, { label = '', accountKey = null } = {}) {
      const row = s.subOf.get(userId, taskName);
      if (!row) throw new Error(`还没有订阅 "${taskName}"，无法添加账号`);
      const existing = s.accountsOfSub.all(row.id);
      if (existing.length >= maxAccounts) {
        throw new Error(`这个模板最多配 ${maxAccounts} 个账号`);
      }
      const key = accountKey ?? newAccountKey();
      s.insertAccount.run({
        subscription_id: row.id,
        account_key: key,
        label: label || '未命名',
        enabled: 1,
        created_at: Date.now(),
      });
      return key;
    }

    function removeAccount(taskName, accountKey) {
      const row = s.subOf.get(userId, taskName);
      if (!row) return false;
      return s.deleteAccount.run(row.id, accountKey).changes > 0;
    }

    /** 该订阅下参与调度的账号（停用的除外） */
    function activeAccounts(taskName) {
      const row = s.subOf.get(userId, taskName);
      if (!row) return [];
      return s.accountsOfSub.all(row.id).filter((a) => a.enabled).map(rowToAccount);
    }

    function isEnabled(taskName) {
      return !!s.subOf.get(userId, taskName)?.enabled;
    }

    /** 与旧版同名，但语义从「全站是否启用」变成「我是否订阅且启用」 */
    function getOverride(taskName) {
      const row = s.subOf.get(userId, taskName);
      if (!row) return null;
      return { taskName, enabled: !!row.enabled, schedule: rowToSubscription(row).schedule, timeoutMs: row.timeout_ms ?? null, updatedAt: row.updated_at };
    }

    function setSubscription(taskName, { enabled, schedule, timeoutMs } = {}) {
      const prev = s.subOf.get(userId, taskName);
      if (!prev) return null;
      assertScheduleAllowed(schedule);
      const prevSchedule = prev.schedule_json ? JSON.parse(prev.schedule_json) : null;
      s.insertSub.run({
        user_id: userId,
        task_name: taskName,
        enabled: (enabled ?? prev.enabled) ? 1 : 0,
        schedule_json: schedule === undefined
          ? (prevSchedule ? JSON.stringify(prevSchedule) : null)
          : schedule
            ? JSON.stringify(schedule)
            : null,
        timeout_ms: timeoutMs === undefined ? prev.timeout_ms : timeoutMs,
        created_at: prev.created_at,
        updated_at: Date.now(),
      });
      return getSubscription(taskName);
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
      const subId = subscriptionId ?? s.subOf.get(userId, taskName)?.id ?? null;
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

    /** 某个账号的历史；不传 accountKey 时返回该模板下全部账号的历史 */
    function runsOfTask(taskName, { accountKey = null, limit = 50 } = {}) {
      const rows = accountKey == null
        ? s.runsOfSubscription.all(userId, taskName, limit)
        : s.runsOfTask.all(userId, taskName, accountKey, limit);
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
      subscribe,
      unsubscribe,
      getSubscription,
      listSubscriptions,
      setSubscription,
      addAccount,
      removeAccount,
      activeAccounts,
      isEnabled,
      getOverride,
      appendRun,
      runsOfTask,
      recentRuns,
      lastSuccess,
      hasSuccessOn,
      hasScheduledRun,
      /** 今日已执行次数（配额用） */
      countRunsToday: (date) => s.countRunsToday.get(userId, date).n,
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
     * 全部订阅及其账号。
     * @param {boolean} [onlyActiveUsers] 调度器要传 true：停用的账号不应继续被调度
     */
    allSubscriptions({ onlyActiveUsers = false } = {}) {
      const rows = onlyActiveUsers ? s.allSubsActive.all() : s.allSubs.all();
      return rows.map((row) => {
        const sub = rowToSubscription(row);
        sub.accounts = s.accountsOfSub.all(row.id).map(rowToAccount);
        return sub;
      });
    },

    /** 保留策略用：有哪些用户在库里有订阅 */
    allUserIds() {
      return [...new Set(s.allSubs.all().map((r) => r.user_id))];
    },

    /**
     * 删号清理：订阅与账号靠 ON DELETE CASCADE，这里清掉没有外键兜底的历史数据。
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
