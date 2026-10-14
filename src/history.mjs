/**
 * 执行记录（业务级）—— data/runs.jsonl 追加写
 *
 * 与 WeMonitor 的 cron-history.jsonl（进程级：exit code / stdout）职责分离：
 * 本文件记录的是「签到成没成、还剩多少流量」这类业务结果。
 *
 * 所有读写函数都接受可选的 `file` 参数（默认指向真实的 data/runs.jsonl），
 * 目的是让测试能把记录写进临时目录，而不是污染部署数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { RUNS_FILE } from './util.mjs';
import { isSuccess } from './task-contract.mjs';

// 状态口径的唯一权威在契约模块；这里转发，避免出现两份定义悄悄漂移
export { SUCCESS_STATUSES, isSuccess } from './task-contract.mjs';

function ensureDirOf(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

export function appendRun(record, file = RUNS_FILE) {
  ensureDirOf(file);
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * 读取最近的执行记录（倒序，最新在前）
 * @param {number} limit 最多返回条数
 * @param {string} file 记录文件路径
 */
export function readRuns(limit = 100, file = RUNS_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    // 不存在 / 无权限 → 降级为空历史。读历史失败不应拖垮整个命令
    return [];
  }

  const lines = raw.split('\n').filter((l) => l.trim());
  const out = [];
  for (const line of lines.slice(-Math.max(limit, 1))) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 跳过损坏行，不让单行错误毁掉整个历史 */
    }
  }
  return out.reverse();
}

/** 某任务最近一次成功 */
export function lastSuccessOf(task, limit = 500, file = RUNS_FILE) {
  return readRuns(limit, file).find((r) => r.task === task && isSuccess(r.status)) ?? null;
}

/** 某任务在指定日期是否已成功（幂等判断的依据） */
export function hasSuccessOn(task, date, limit = 500, file = RUNS_FILE) {
  return readRuns(limit, file).some(
    (r) => r.task === task && r.date === date && isSuccess(r.status),
  );
}
