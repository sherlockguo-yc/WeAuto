/**
 * 数据访问层 —— 执行记录、运行日志、任务覆盖层、调度状态、每日统计
 *
 * 单独成层的原因：调度器（常驻）与 HTTP 接口（请求期）都要写同一批表。
 * SQL 散在两个地方，早晚会出现「一处写了 date、另一处忘了」的不一致。
 *
 * 两条与保留策略相关的约定：
 *   · 删除明细前先把计数累加进 run_stats_daily，这样长期趋势仍可查
 *   · 统计是**累加计数器**（每行明细只会被累加一次，因为累加后立刻删除）
 */
import { SUCCESS_STATUSES } from './task-contract.mjs';

const DAY_MS = 86_400_000;

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
    task: row.task_name,
    accountKey: row.account_key,
    date: row.date,
    ts: row.ts,
    status: row.status,
    message: row.message,
    data,
    dur: row.dur,
    trigger: row.trigger,
  };
}

export function createStore(db) {
  const successList = [...SUCCESS_STATUSES];

  const s = {
    // 覆盖层
    getOverride: db.prepare('SELECT * FROM tasks WHERE task_name = ?'),
    allOverrides: db.prepare('SELECT * FROM tasks'),
    upsertOverride: db.prepare(
      `INSERT INTO tasks (task_name, enabled, schedule_json, timeout_ms, updated_at)
       VALUES (@task_name, @enabled, @schedule_json, @timeout_ms, @updated_at)
       ON CONFLICT(task_name) DO UPDATE SET
         enabled = @enabled, schedule_json = @schedule_json,
         timeout_ms = @timeout_ms, updated_at = @updated_at`,
    ),
    deleteOverride: db.prepare('DELETE FROM tasks WHERE task_name = ?'),

    // 执行记录
    insertRun: db.prepare(
      `INSERT INTO runs (task_name, account_key, date, ts, status, message, data_json, dur, trigger)
       VALUES (@task_name, @account_key, @date, @ts, @status, @message, @data_json, @dur, @trigger)`,
    ),
    runById: db.prepare('SELECT * FROM runs WHERE id = ?'),
    runsOfTask: db.prepare('SELECT * FROM runs WHERE task_name = ? ORDER BY ts DESC LIMIT ?'),
    runsAll: db.prepare('SELECT * FROM runs ORDER BY ts DESC LIMIT ?'),
    // 历史列表默认隐藏 skipped：否则 interval 类任务会把有用的行挤下去
    runsExecuted: db.prepare(`SELECT * FROM runs WHERE status <> 'skipped' ORDER BY ts DESC LIMIT ?`),
    lastSuccess: db.prepare(
      `SELECT * FROM runs WHERE task_name = ? AND status IN (${successList.map(() => '?').join(',')})
       ORDER BY ts DESC LIMIT 1`,
    ),
    successOnDate: db.prepare(
      `SELECT COUNT(*) AS n FROM runs WHERE task_name = ? AND date = ?
       AND status IN (${successList.map(() => '?').join(',')})`,
    ),
    scheduledCount: db.prepare(
      `SELECT COUNT(*) AS n FROM runs WHERE task_name = ? AND trigger = 'schedule'`,
    ),
    allRunsForPrune: db.prepare(
      'SELECT id, date, status, ts FROM runs WHERE task_name = ? ORDER BY ts ASC',
    ),
    deleteRun: db.prepare('DELETE FROM runs WHERE id = ?'),

    // 日志
    insertLog: db.prepare('INSERT INTO run_logs (run_id, task_name, ts, line) VALUES (?, ?, ?, ?)'),
    logsOfRun: db.prepare('SELECT ts, line FROM run_logs WHERE run_id = ? ORDER BY id'),
    deleteLogsBefore: db.prepare('DELETE FROM run_logs WHERE task_name = ? AND ts < ?'),

    // 调度状态
    getState: db.prepare('SELECT * FROM task_state WHERE task_name = ?'),
    upsertState: db.prepare(
      `INSERT INTO task_state (task_name, today_date, today_target_ts, next_due_ts, last_run_id, updated_at)
       VALUES (@task_name, @today_date, @today_target_ts, @next_due_ts, @last_run_id, @updated_at)
       ON CONFLICT(task_name) DO UPDATE SET
         today_date = @today_date, today_target_ts = @today_target_ts,
         next_due_ts = @next_due_ts, last_run_id = @last_run_id, updated_at = @updated_at`,
    ),

    // 统计
    statsOfTask: db.prepare(
      'SELECT * FROM run_stats_daily WHERE task_name = ? ORDER BY date DESC LIMIT ?',
    ),
    addStat: db.prepare(
      `INSERT INTO run_stats_daily (task_name, date, success, failed, skipped, total)
       VALUES (@task_name, @date, @success, @failed, @skipped, @total)
       ON CONFLICT(task_name, date) DO UPDATE SET
         success = success + excluded.success,
         failed  = failed  + excluded.failed,
         skipped = skipped + excluded.skipped,
         total   = total   + excluded.total`,
    ),
  };

  function stateOf(taskName) {
    const row = s.getState.get(taskName);
    return row
      ? {
          today_date: row.today_date,
          today_target_ts: row.today_target_ts,
          next_due_ts: row.next_due_ts,
          last_run_id: row.last_run_id,
        }
      : {};
  }

  return {
    /** 覆盖层：不存在表示「跟随任务文件的默认值」 */
    getOverride(taskName) {
      const row = s.getOverride.get(taskName);
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
        taskName: row.task_name,
        enabled: !!row.enabled,
        schedule,
        timeoutMs: row.timeout_ms ?? null,
        updatedAt: row.updated_at,
      };
    },

    /** 覆盖层只在用户显式改过时才有行；这里写入的是「用户的选择」 */
    setOverride(taskName, { enabled, schedule, timeoutMs } = {}) {
      const prev = this.getOverride(taskName);
      s.upsertOverride.run({
        task_name: taskName,
        enabled: (enabled ?? prev?.enabled ?? true) ? 1 : 0,
        schedule_json: schedule === undefined ? (prev?.schedule ? JSON.stringify(prev.schedule) : null) : schedule ? JSON.stringify(schedule) : null,
        timeout_ms: timeoutMs === undefined ? (prev?.timeoutMs ?? null) : timeoutMs,
        updated_at: Date.now(),
      });
      return this.getOverride(taskName);
    },

    /** 清掉覆盖，回到任务文件的默认值 */
    clearOverride(taskName) {
      return s.deleteOverride.run(taskName).changes > 0;
    },

    isEnabled(taskName) {
      return this.getOverride(taskName)?.enabled ?? true;
    },

    appendRun({ taskName, accountKey = null, date, ts, status, message = '', data = null, dur = 0, trigger = 'schedule' }) {
      const info = s.insertRun.run({
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
    },

    getRun: (id) => rowToRun(s.runById.get(id)),

    /** 最近记录（含 skipped），用于任务详情的历史 */
    runsOfTask: (taskName, limit = 50) => s.runsOfTask.all(taskName, limit).map(rowToRun),

    /** 全部任务最近记录；默认隐藏 skipped（首页要的是「谁出事了」） */
    recentRuns(limit = 50, { includeSkipped = false } = {}) {
      const rows = includeSkipped ? s.runsAll.all(limit) : s.runsExecuted.all(limit);
      return rows.map(rowToRun);
    },

    lastSuccess(taskName) {
      return rowToRun(s.lastSuccess.get(taskName, ...successList));
    },

    hasSuccessOn(taskName, date) {
      return s.successOnDate.get(taskName, date, ...successList).n > 0;
    },

    /**
     * 一次性任务是否已经跑过（只算调度触发的）。
     * 手动触发不算「已执行」，否则手滑点一下就会把计划时刻吃掉。
     */
    hasScheduledRun(taskName) {
      return s.scheduledCount.get(taskName).n > 0;
    },

    appendLogs(runId, taskName, lines, ts = Date.now()) {
      const tx = db.transaction(() => {
        for (const line of lines) s.insertLog.run(runId, taskName, ts, String(line));
      });
      tx();
    },

    logsOfRun: (runId) => s.logsOfRun.all(runId),

    stateOf,
    /** 局部更新调度状态（合并式写入，调用方只关心自己那几个字段） */
    saveState(taskName, patch) {
      const merged = { ...stateOf(taskName), ...patch };
      s.upsertState.run({
        task_name: taskName,
        today_date: merged.today_date ?? null,
        today_target_ts: merged.today_target_ts ?? null,
        next_due_ts: merged.next_due_ts ?? null,
        last_run_id: merged.last_run_id ?? null,
        updated_at: Date.now(),
      });
      return stateOf(taskName);
    },

    statsOfTask: (taskName, limit = 90) => s.statsOfTask.all(taskName, limit),

    /**
     * 保留策略：先聚合、再删明细。
     *
     * 两个维度都要：只按天数删，挡不住 interval 类任务（30 分钟一次 = 一天 48 条）；
     * 只按条数删，又会让「很久没跑的任务」永远留着陈年记录。
     */
    pruneTask(taskName, retention, nowMs = Date.now()) {
      const cutoff = nowMs - retention.days * DAY_MS;
      const all = s.allRunsForPrune.all(taskName);

      const keep = [];
      const drop = [];
      for (const r of all) (r.ts < cutoff ? drop : keep).push(r);

      const over = keep.length - retention.maxRows;
      if (over > 0) drop.push(...keep.splice(0, over));

      if (!drop.length) return { dropped: 0, aggregated: 0 };

      const byDate = new Map();
      for (const r of drop) {
        const acc = byDate.get(r.date) ?? { success: 0, failed: 0, skipped: 0, total: 0 };
        const ok = SUCCESS_STATUSES.has(r.status);
        if (ok) acc.success += 1;
        else if (r.status === 'skipped') acc.skipped += 1;
        else acc.failed += 1;
        acc.total += 1;
        byDate.set(r.date, acc);
      }

      const tx = db.transaction(() => {
        for (const [date, acc] of byDate) {
          s.addStat.run({ task_name: taskName, date, ...acc });
        }
        for (const r of drop) s.deleteRun.run(r.id);
      });
      tx();

      // 日志按自己的保留期单独清理（随 runs 级联删除的那部分已自动处理）
      const logCutoff = nowMs - (retention.logDays ?? retention.days) * DAY_MS;
      const { changes } = s.deleteLogsBefore.run(taskName, logCutoff);

      return { dropped: drop.length, aggregated: byDate.size, logsDropped: changes };
    },
  };
}
