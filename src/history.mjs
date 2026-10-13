/**
 * 执行记录（业务级）—— data/runs.jsonl 追加写
 *
 * 与 WeMonitor 的 cron-history.jsonl（进程级：exit code / stdout）职责分离：
 * 本文件记录的是「签到成没成、还剩多少流量」这类业务结果。
 */
import fs from 'node:fs';
import { RUNS_FILE, ensureDataDir } from './util.mjs';

/** 视为「今天这件事已经办成了」的状态 */
export const SUCCESS_STATUSES = new Set(['success', 'already-signed']);

export function isSuccess(status) {
  return SUCCESS_STATUSES.has(status);
}

export function appendRun(record) {
  ensureDataDir();
  fs.appendFileSync(RUNS_FILE, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * 读取最近的执行记录（倒序，最新在前）
 * @param {number} limit 最多返回条数
 */
export function readRuns(limit = 100) {
  if (!fs.existsSync(RUNS_FILE)) return [];
  const lines = fs
    .readFileSync(RUNS_FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
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
export function lastSuccessOf(task, limit = 500) {
  return readRuns(limit).find((r) => r.task === task && isSuccess(r.status)) ?? null;
}

/** 某任务在指定日期是否已成功（幂等判断的依据） */
export function hasSuccessOn(task, date, limit = 500) {
  return readRuns(limit).some((r) => r.task === task && r.date === date && isSuccess(r.status));
}
